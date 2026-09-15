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
  const manifest = await fetchJson(url, { headers: { 'User-Agent': 'FastShare-Webshare-Concert-Bridge/7.12' } });
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
      const data = await fetchJson(url, { headers: { 'User-Agent': 'FastShare-Webshare-Concert-Bridge/7.12' } });
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

function mergeLinks(reference, enriched, title, ids = {}) {
  const links = [];
  for (const item of [...(reference?.links || []), ...(enriched?.links || [])]) {
    if (!item) continue;
    const key = JSON.stringify(item);
    if (!links.some(x => JSON.stringify(x) === key)) links.push(item);
  }
  if (ids.imdbId && !links.some(x => String(x?.url || '').includes('imdb.com/title/'))) {
    links.push({ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${ids.imdbId}/` });
  }
  if (ids.tmdbId && !links.some(x => String(x?.url || '').includes('themoviedb.org/'))) {
    links.push({ name: 'TMDB', category: 'tmdb', url: `https://www.themoviedb.org/movie/${ids.tmdbId}` });
  }
  if (ids.csfdUrl) links.push({ name: 'ČSFD', category: 'csfd', url: ids.csfdUrl });
  else links.push({ name: 'ČSFD', category: 'csfd', url: csfdSearchLink(title) });
  return links;
}

function sourceFilename(source) {
  return String(
    source?.behaviorHints?.filename ||
    source?.filename ||
    source?.videoFilename ||
    source?.file ||
    ''
  ).trim();
}

function cleanFilenameTitle(filename) {
  return String(filename || '')
    .replace(/\.[a-z0-9]{2,5}$/i, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^\)]*(?:rip|codec|audio|subs?|gb|mb)[^\)]*\)/ig, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|dv|dolby|web[- ]?dl|webrip|bluray|brrip|hdrip|dvdrip|remux|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|ddp|dts|truehd|atmos|flac|mp3)\b/ig, ' ')
    .replace(/\b(cz|cze|cs|sk|svk|eng|en)\s*(dab|dub|dabing|audio|subs?|tit|titulky)?\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractExternalIds(source) {
  const ids = {
    imdbId: null,
    tmdbId: null,
    csfdUrl: null
  };
  const values = [
    source?.id,
    source?.imdbId,
    source?.tmdbId,
    ...(Array.isArray(source?.links) ? source.links.flatMap(link => [link?.url, link?.name, link?.id]) : [])
  ].filter(Boolean).map(String);

  for (const value of values) {
    const imdb = value.match(/\b(tt\d{5,12})\b/i);
    if (imdb && !ids.imdbId) ids.imdbId = imdb[1];

    const tmdb = value.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i) || value.match(/^tmdb:(?:movie|tv)?:?(\d+)$/i);
    if (tmdb && !ids.tmdbId) ids.tmdbId = tmdb[1];

    if (/csfd\.(?:cz|sk)\//i.test(value) && !ids.csfdUrl) ids.csfdUrl = value;
  }
  return ids;
}

function bestSearchTitle(source) {
  const filename = sourceFilename(source);
  const fromFile = cleanFilenameTitle(filename);
  const sourceTitle = String(source?.name || source?.title || '').trim();
  const chosen = fromFile && normalize(fromFile).length >= 5 ? fromFile : sourceTitle;
  const year = String(filename || source?.releaseInfo || source?.year || sourceTitle).match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '';
  return { filename, title: chosen || sourceTitle, year };
}

async function enrichByExternalId(runtime, ids, source) {
  if (!ids.imdbId || typeof runtime.getMeta !== 'function') return null;
  try {
    const data = await runtime.getMeta('movie', ids.imdbId);
    const raw = data?.raw || {};
    return {
      name: raw.name || raw.title || data?.title,
      poster: raw.poster,
      background: raw.background,
      description: raw.description,
      releaseInfo: raw.releaseInfo,
      year: raw.year,
      genres: raw.genres,
      imdbRating: raw.imdbRating,
      runtime: raw.runtime,
      links: raw.links,
      imdbId: ids.imdbId,
      tmdbId: data?.tmdbId || ids.tmdbId
    };
  } catch {
    return null;
  }
}

async function enrichReferenceMeta(runtime, source) {
  const ids = extractExternalIds(source);
  const search = bestSearchTitle(source);
  const sourceTitle = String(source?.name || source?.title || search.title || '').trim();

  let enriched = await enrichByExternalId(runtime, ids, source);

  if (!enriched) {
    const fake = {
      title: [search.title || sourceTitle, search.year].filter(Boolean).join(' '),
      filename: search.filename || sourceTitle,
      provider: 'Reference/Webshare/FastShare',
      size: 0
    };
    try {
      if (runtime.enrichConcertWithWikipedia) enriched = await runtime.enrichConcertWithWikipedia(fake);
      else if (runtime.enrichConcert) enriched = await runtime.enrichConcert(fake);
    } catch {}
  }

  const localId = encodeConcertId(sourceTitle || search.title);
  const year = search.year || String(source?.releaseInfo || source?.year || '').match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '';
  const meta = {
    ...source,
    id: localId,
    type: 'movie',
    name: enriched?.name || sourceTitle || search.title,
    poster: source?.poster || enriched?.poster,
    background: source?.background || enriched?.background,
    description: source?.description || enriched?.description || `Koncert: ${sourceTitle || search.title}`,
    releaseInfo: source?.releaseInfo || enriched?.releaseInfo || year,
    year: source?.year || enriched?.year || (year ? Number(year) : undefined),
    genres: source?.genres?.length ? source.genres : (enriched?.genres?.length ? enriched.genres : ['Music']),
    imdbRating: source?.imdbRating || enriched?.imdbRating,
    runtime: source?.runtime || enriched?.runtime,
    links: mergeLinks(source, enriched, sourceTitle || search.title, {
      imdbId: enriched?.imdbId || ids.imdbId,
      tmdbId: enriched?.tmdbId || ids.tmdbId,
      csfdUrl: ids.csfdUrl
    }),
    behaviorHints: {
      ...(source?.behaviorHints || {}),
      defaultVideoId: localId,
      ...(search.filename ? { filename: search.filename } : {})
    }
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
        count: metas.length,
        withFilename: sourceMetas.filter(sourceFilename).length,
        withExternalId: sourceMetas.filter(item => {
          const ids = extractExternalIds(item);
          return Boolean(ids.imdbId || ids.tmdbId || ids.csfdUrl);
        }).length
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
    enrichReferenceConcertMeta: source => enrichReferenceMeta(runtime, source),
    extractConcertExternalIds: extractExternalIds,
    bestConcertSearchTitle: bestSearchTitle
  };
}

module.exports = install;
