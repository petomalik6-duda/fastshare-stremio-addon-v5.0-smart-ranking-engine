'use strict';

const { normalize, mapWithConcurrency } = require('./utils');
const { CATALOGS } = require('./catalogs');

const EXTRA_CATALOGS = [
  { id: 'unified-concerts-new', type: 'movie', name: '🆕 Nové koncerty' },
  { id: 'unified-concerts-4k', type: 'movie', name: '🎬 4K koncerty' },
  { id: 'unified-concerts-rock', type: 'movie', name: '🎸 Rock koncerty' },
  { id: 'unified-concerts-pop', type: 'movie', name: '🎤 Pop koncerty' }
];
for (const def of EXTRA_CATALOGS) {
  if (!CATALOGS.some(x => x.id === def.id && x.type === def.type)) CATALOGS.push(def);
}

const ALL_IDS = new Set(['unified-concerts', ...EXTRA_CATALOGS.map(x => x.id)]);
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function encodeConcertId(title) {
  return `concert:${Buffer.from(String(title || '').slice(0, 180), 'utf8').toString('base64url')}`;
}
function decodeConcertId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('concert:')) return '';
  try { return Buffer.from(raw.slice(8), 'base64url').toString('utf8'); } catch { return ''; }
}

function cleanFilename(filename) {
  return String(filename || '')
    .replace(/\.[a-z0-9]{2,5}$/i, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^\)]*(?:rip|codec|audio|subs?|gb|mb)[^\)]*\)/ig, ' ')
    .replace(/\b(4320p|2160p|1080p|720p|576p|480p|8k|4k|uhd|hdr10\+?|hdr|dv|dolby|web[- ]?dl|webrip|bluray|brrip|hdrip|dvdrip|remux|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|ddp|dts|truehd|atmos|flac|mp3)\b/ig, ' ')
    .replace(/\b(cz|cze|cs|sk|svk|eng|en)\s*(dab|dub|dabing|audio|subs?|tit|titulky)?\b/ig, ' ')
    .replace(/\b(proper|repack|internal|limited|complete|extended)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function yearOf(value) {
  return String(value || '').match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '';
}
function qualityOf(value) {
  const s = String(value || '');
  if (/\b(2160p|4k|uhd)\b/i.test(s)) return '2160p';
  if (/\b1080p\b/i.test(s)) return '1080p';
  if (/\b720p\b/i.test(s)) return '720p';
  return '';
}

function semanticTitle(item) {
  const filename = item.filename || item.behaviorHints?.filename || '';
  const cleaned = cleanFilename(filename);
  const name = String(item.name || item.title || cleaned || '').trim();
  const chosen = cleaned && normalize(cleaned).length >= 5 ? cleaned : name;
  return chosen.replace(/\s+/g, ' ').trim();
}

function dedupeKey(item) {
  const title = semanticTitle(item);
  const noYear = normalize(title).replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
  const year = yearOf(item.releaseInfo || item.year || title || item.filename);
  return `${noYear}|${year}`;
}

function concertScore(item) {
  const text = `${item.name || ''} ${item.title || ''} ${item.filename || ''} ${item.description || ''}`;
  let score = 0;
  if (/\b(concert|koncert)\b/i.test(text)) score += 35;
  if (/\blive\s+(at|in|from)\b/i.test(text)) score += 30;
  if (/\b(world\s+tour|tour\s+live|unplugged|festival|live\s+performance)\b/i.test(text)) score += 25;
  if (/\b(19\d{2}|20\d{2})\b/.test(text)) score += 10;
  if (/\b(2160p|1080p|720p|4k|uhd|bluray|remux)\b/i.test(text)) score += 5;
  if (/\b(documentary|document|interview|behind\s+the\s+scenes|music\s+video|videoclip|clip)\b/i.test(text)) score -= 35;
  if (/\b(sample|trailer|teaser)\b/i.test(text)) score -= 60;
  return score;
}

const ROCK_RX = /\b(rock|metal|hard rock|heavy metal|punk|grunge|alternative rock|indie rock|progressive|guitar)\b/i;
const POP_RX = /\b(pop|dance|synthpop|electropop|r&b|soul|disco|vocal)\b/i;
function categoryOf(meta) {
  const text = `${(meta.genres || []).join(' ')} ${meta.name || ''} ${meta.description || ''} ${meta.behaviorHints?.filename || ''}`;
  if (ROCK_RX.test(text)) return 'rock';
  if (POP_RX.test(text)) return 'pop';
  return '';
}

async function referenceRows(runtime) {
  if (typeof runtime.fetchReferenceConcertCatalog !== 'function') return [];
  const offsets = [0, 50, 100, 150];
  const pages = await mapWithConcurrency(offsets, 2, async skip => {
    try { return await runtime.fetchReferenceConcertCatalog(skip); } catch { return null; }
  });
  return pages.flatMap((page, pageIndex) => {
    const metas = Array.isArray(page?.payload?.metas) ? page.payload.metas : [];
    return metas.map((m, index) => ({
      ...m,
      _source: 'reference',
      _sourceRank: pageIndex * 50 + index,
      filename: m?.behaviorHints?.filename || m?.filename || ''
    }));
  });
}

async function providerRows(runtime, req) {
  if (typeof runtime.discoverConcerts !== 'function') return [];
  try {
    const rows = await runtime.discoverConcerts(req);
    return (Array.isArray(rows) ? rows : []).map((r, index) => ({ ...r, _source: 'provider', _sourceRank: index }));
  } catch { return []; }
}

async function buildPool(runtime, req) {
  const cfg = runtime.unifiedConfig ? runtime.unifiedConfig(req) : {};
  const cacheKey = `${cfg?.fastshare?.username || ''}|${cfg?.webshare?.username || ''}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const [reference, provider] = await Promise.all([referenceRows(runtime), providerRows(runtime, req)]);
  const merged = [...reference, ...provider].filter(x => concertScore(x) >= 20);
  const map = new Map();
  for (const row of merged) {
    const key = dedupeKey(row);
    if (!key || key.length < 6) continue;
    const existing = map.get(key);
    const candidate = {
      ...row,
      title: semanticTitle(row),
      filename: row.filename || row.behaviorHints?.filename || '',
      _quality: qualityOf(row.filename || row.name || row.title),
      _score: concertScore(row),
      _year: yearOf(row.releaseInfo || row.year || row.title || row.filename),
      _providers: new Set([row._source || 'unknown'])
    };
    if (!existing) {
      map.set(key, candidate);
      continue;
    }
    existing._providers.add(row._source || 'unknown');
    const existingWeight = (existing.poster ? 20 : 0) + (existing.description ? 10 : 0) + existing._score + (existing._quality === '2160p' ? 5 : 0);
    const candidateWeight = (candidate.poster ? 20 : 0) + (candidate.description ? 10 : 0) + candidate._score + (candidate._quality === '2160p' ? 5 : 0);
    if (candidateWeight > existingWeight) {
      candidate._providers = existing._providers;
      map.set(key, candidate);
    }
  }

  const value = [...map.values()].sort((a, b) => {
    const ay = Number(a._year || 0), by = Number(b._year || 0);
    if (by !== ay) return by - ay;
    if (b._providers.size !== a._providers.size) return b._providers.size - a._providers.size;
    if (b._score !== a._score) return b._score - a._score;
    return Number(b.size || 0) - Number(a.size || 0);
  });
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function enrich(runtime, row) {
  let meta = null;
  if (row._source === 'reference' && typeof runtime.enrichReferenceConcertMeta === 'function') {
    try { meta = await runtime.enrichReferenceConcertMeta(row); } catch {}
  }
  if (!meta && typeof runtime.enrichConcertWithWikipedia === 'function') {
    try { meta = await runtime.enrichConcertWithWikipedia({ title: row.title, filename: row.filename || row.title, provider: 'Webshare/FastShare', size: row.size || 0 }); } catch {}
  }
  if (!meta && typeof runtime.enrichConcert === 'function') {
    try { meta = await runtime.enrichConcert({ title: row.title, filename: row.filename || row.title, provider: 'Webshare/FastShare', size: row.size || 0 }); } catch {}
  }
  meta = meta || row;
  const id = encodeConcertId(row.title);
  return {
    ...meta,
    id,
    type: 'movie',
    name: meta.name || row.title,
    releaseInfo: meta.releaseInfo || row._year || '',
    year: meta.year || (row._year ? Number(row._year) : undefined),
    genres: meta.genres?.length ? meta.genres : ['Music'],
    description: meta.description || `Živý koncert ${row.title}.`,
    behaviorHints: {
      ...(meta.behaviorHints || {}),
      defaultVideoId: id,
      ...(row.filename ? { filename: row.filename } : {})
    },
    _quality: row._quality,
    _sourceRank: row._sourceRank,
    _providers: [...row._providers]
  };
}

function filterForCatalog(id, metas) {
  if (id === 'unified-concerts-4k') return metas.filter(m => m._quality === '2160p' || /\b(2160p|4k|uhd)\b/i.test(m.behaviorHints?.filename || ''));
  if (id === 'unified-concerts-rock') return metas.filter(m => categoryOf(m) === 'rock');
  if (id === 'unified-concerts-pop') return metas.filter(m => categoryOf(m) === 'pop');
  if (id === 'unified-concerts-new') return metas.slice().sort((a, b) => Number(b.year || b.releaseInfo || 0) - Number(a.year || a.releaseInfo || 0));
  return metas;
}

function publicMeta(meta) {
  const { _quality, _sourceRank, _providers, ...clean } = meta;
  clean.description = [clean.description, _providers?.length ? `Dostupnosť: ${_providers.join(' + ')}.` : ''].filter(Boolean).join(' ');
  return clean;
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
    try { return Math.max(0, Number(new URLSearchParams(decodeURIComponent(extra)).get('skip') || 0)); } catch { return 0; }
  }

  async function sendCatalog(req, res) {
    if (req.params.type !== 'movie' || !ALL_IDS.has(req.params.id)) return runtime.sendCatalog(req, res);
    try {
      const pool = await buildPool(runtime, req);
      const enriched = await mapWithConcurrency(pool.slice(0, 180), 5, row => enrich(runtime, row));
      const filtered = filterForCatalog(req.params.id, enriched);
      const skip = skipOf(req.params.extra);
      const metas = filtered.slice(skip, skip + 40).map(publicMeta);
      res.set('Cache-Control', 'private, max-age=300');
      console.log('[concert-super-catalog]', JSON.stringify({ id: req.params.id, pool: pool.length, enriched: enriched.length, filtered: filtered.length, skip, count: metas.length }));
      return res.json({ metas });
    } catch (error) {
      console.error('[concert-super-error]', String(error?.message || error));
      return runtime.sendCatalog(req, res);
    }
  }

  async function sendMeta(req, res) {
    const title = decodeConcertId(req.params.id);
    if (!title) {
      try {
        const data = await runtime.getMeta(req.params.type, req.params.id);
        const raw = data?.raw || {};
        return res.json({ meta: { ...raw, id: raw.id || data.imdbId || req.params.id, type: req.params.type, name: raw.name || raw.title || data.title || req.params.id } });
      } catch { return res.status(404).json({ meta: null }); }
    }
    try {
      const meta = await enrich(runtime, { title, name: title, filename: title, _source: 'provider', _providers: new Set(['provider']), _score: 30, _year: yearOf(title), _quality: qualityOf(title) });
      return res.json({ meta: publicMeta(meta) });
    } catch { return res.json({ meta: { id: req.params.id, type: 'movie', name: title, genres: ['Music'] } }); }
  }

  app.get('/catalog/:type/:id.json', sendCatalog);
  app.get('/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/:config/catalog/:type/:id.json', sendCatalog);
  app.get('/:config/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/meta/:type/:id.json', sendMeta);
  app.get('/:config/meta/:type/:id.json', sendMeta);

  return { ...runtime, buildConcertPool: req => buildPool(runtime, req), concertSuperCatalog: true };
}

module.exports = install;
