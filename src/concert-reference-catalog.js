'use strict';

const { fetchJson, mapWithConcurrency, normalize } = require('./utils');

const CACHE_TTL = 10 * 60 * 1000;
const state = {
  manifestAt: 0,
  manifest: null,
  catalog: null,
  pages: new Map(),
  metas: new Map()
};

function referenceManifestUrl() {
  return String(process.env.REFERENCE_CONCERT_MANIFEST || '').trim();
}

function encodeConcertId(title) {
  return `concert:${Buffer.from(String(title || '').slice(0, 180), 'utf8').toString('base64url')}`;
}

function decodeConcertId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('concert:')) return '';
  try { return Buffer.from(raw.slice(8), 'base64url').toString('utf8'); } catch { return ''; }
}

function referenceBase(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json(?:\?.*)?$/i, '');
}

function chooseConcertCatalog(manifest) {
  const catalogs = Array.isArray(manifest?.catalogs) ? manifest.catalogs : [];
  const scored = catalogs.map(catalog => {
    const text = `${catalog?.id || ''} ${catalog?.name || ''}`.toLowerCase();
    let score = 0;
    if (/koncert/.test(text)) score += 100;
    if (/concert/.test(text)) score += 90;
    if (/live/.test(text)) score += 20;
    if (/music|hudb/.test(text)) score += 10;
    return { catalog, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].catalog : null;
}

async function loadReferenceManifest() {
  const url = referenceManifestUrl();
  if (!url) return null;
  if (state.manifest && Date.now() - state.manifestAt < CACHE_TTL) return state.manifest;
  const manifest = await fetchJson(url, { headers: { 'User-Agent': 'FastShare-Webshare-Concert-Bridge/7.11' } });
  state.manifest = manifest;
  state.manifestAt = Date.now();
  state.catalog = chooseConcertCatalog(manifest);
  return manifest;
}

async function fetchReferenceCatalog(skip = 0) {
  const manifestUrl = referenceManifestUrl();
  if (!manifestUrl) return null;
  await loadReferenceManifest();
  const catalog = state.catalog;
  if (!catalog?.id || !catalog?.type) return null;

  const cacheKey = `${catalog.type}:${catalog.id}:${skip}`;
  const cached = state.pages.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

  const base = referenceBase(manifestUrl);
  const id = encodeURIComponent(catalog.id);
  const type = encodeURIComponent(catalog.type);
  const candidates = [
    `${base}/catalog/${type}/${id}/skip=${Math.max(0, Number(skip || 0))}.json`,
    `${base}/catalog/${type}/${id}.json?skip=${Math.max(0, Number(skip || 0))}`,
    `${base}/catalog/${type}/${id}.json`
  ];

  let payload = null;
  let usedUrl = null;
  for (const url of candidates) {
    try {
      const data = await fetchJson(url, { headers: { 'User-Agent': 'FastShare-Webshare-Concert-Bridge/7.11' } });
      if (Array.isArray(data?.metas)) {
        payload = data;
        usedUrl = url;
        break;
      }
    } catch {}
  }

  if (!payload) return null;
  const value = { payload, catalog, usedUrl };
  state.pages.set(cacheKey, { at: Date.now(), value });
  return value;
}

function csfdSearchLink(title) {
  return `https://www.csfd.cz/hledat/?q=${encodeURIComponent(String(title || ''))}`;
}

function mergeLinks(reference, enriched, title) {
  const links = [];
  for (const item of [...(reference?.links || []), ...(enriched?.links || [])]) {
    if (!item) continue;
    const key = JSON.stringify(item);
    if (!links.some(x => JSON.stringify(x) === key)) links.push(item);
  }
  links.push({ name: 'ČSFD', category: 'csfd', url: csfdSearchLink(title) });
  return links;
}

async function enrichReferenceMeta(runtime, source) {
  const title = source?.name || source?.title || '';
  const year = String(source?.releaseInfo || source?.year || '').match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '';
  const fake = {
    title: [title, year].filter(Boolean).join(' '),
    filename: title,
    provider: 'Reference/Webshare/FastShare',
    size: 0
  };

  let enriched = null;
  try {
    if (runtime.enrichConcertWithWikipedia) enriched = await runtime.enrichConcertWithWikipedia(fake);
    else if (runtime.enrichConcert) enriched = await runtime.enrichConcert(fake);
  } catch {}

  const localId = encodeConcertId(title);
  const meta = {
    ...source,
    id: localId,
    type: 'movie',
    name: enriched?.name || source?.name || title,
    poster: source?.poster || enriched?.poster,
    background: source?.background || enriched?.background,
    description: source?.description || enriched?.description || `Koncert: ${title}`,
    releaseInfo: source?.releaseInfo || enriched?.releaseInfo || year,
    year: source?.year || enriched?.year || (year ? Number(year) : undefined),
    genres: source?.genres?.length ? source.genres : (enriched?.genres?.length ? enriched.genres : ['Music']),
    imdbRating: source?.imdbRating || enriched?.imdbRating,
    runtime: source?.runtime || enriched?.runtime,
    links: mergeLinks(source, enriched, title),
    behaviorHints: { ...(source?.behaviorHints || {}), defaultVideoId: localId }
  };
  state.metas.set(localId, meta);
  return meta;
}

function install(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  const catalogPaths = new Set([
    '/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'
  ]);
  const metaPaths = new Set(['/meta/:type/:id.json', '/:config/meta/:type/:id.json']);
  app._router.stack = app._router.stack.filter(layer => !layer.route || (!catalogPaths.has(layer.route.path) && !metaPaths.has(layer.route.path)));

  function skipOf(extra) {
    if (!extra) return 0;
    try { return Math.max(0, Number(new URLSearchParams(decodeURIComponent(extra)).get('skip') || 0)); }
    catch { return 0; }
  }

  async function sendCatalog(req, res) {
    if (req.params.id !== 'unified-concerts' || req.params.type !== 'movie') return runtime.sendCatalog(req, res);
    const skip = skipOf(req.params.extra);
    try {
      const reference = await fetchReferenceCatalog(skip);
      const sourceMetas = Array.isArray(reference?.payload?.metas) ? reference.payload.metas : [];
      if (!sourceMetas.length) return runtime.sendCatalog(req, res);

      const metas = await mapWithConcurrency(sourceMetas.slice(0, 50), 5, item => enrichReferenceMeta(runtime, item));
      res.set('Cache-Control', 'private, max-age=300');
      console.log('[concert-reference-catalog]', JSON.stringify({
        catalogId: reference.catalog?.id,
        catalogName: reference.catalog?.name,
        skip,
        sourceCount: sourceMetas.length,
        count: metas.length
      }));
      res.json({ metas });
    } catch (error) {
      console.error('[concert-reference-error]', String(error?.message || error));
      return runtime.sendCatalog(req, res);
    }
  }

  async function sendMeta(req, res) {
    const title = decodeConcertId(req.params.id);
    if (title) {
      const cached = state.metas.get(req.params.id);
      if (cached) return res.json({ meta: cached });
      const meta = await enrichReferenceMeta(runtime, { name: title, type: 'movie' });
      return res.json({ meta });
    }

    try {
      const data = await runtime.getMeta(req.params.type, req.params.id);
      const raw = data?.raw || {};
      res.json({ meta: {
        ...raw,
        id: raw.id || data.imdbId || req.params.id,
        type: raw.type || req.params.type,
        name: raw.name || raw.title || data.title || req.params.id
      }});
    } catch {
      res.status(404).json({ meta: null });
    }
  }

  app.get('/catalog/:type/:id.json', sendCatalog);
  app.get('/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/:config/catalog/:type/:id.json', sendCatalog);
  app.get('/:config/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/meta/:type/:id.json', sendMeta);
  app.get('/:config/meta/:type/:id.json', sendMeta);

  return {
    ...runtime,
    referenceConcertManifest: loadReferenceManifest,
    fetchReferenceConcertCatalog: fetchReferenceCatalog,
    enrichReferenceConcertMeta: source => enrichReferenceMeta(runtime, source)
  };
}

module.exports = install;
