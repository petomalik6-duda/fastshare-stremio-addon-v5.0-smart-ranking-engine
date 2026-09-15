'use strict';

const { login: fastshareLogin, searchFastshare } = require('./fastshare');
const { login: webshareLogin, searchWebshare } = require('./webshare');
const { mapWithConcurrency, normalize, fetchJson } = require('./utils');
const { TMDB_API_KEY, TMDB_READ_ACCESS_TOKEN, VERSION } = require('./config');

const TERMS = ['concert', 'live concert', 'world tour', 'unplugged', 'festival', 'live at', 'live in'];
const CONCERT_RX = /\b(concert|live\s+(at|in|from)|world\s+tour|tour\s+live|unplugged|festival|live\s+concert|live\s+performance)\b/i;
const VIDEO_RX = /\.(mkv|mp4|avi|mov|m4v)(?:$|[?\s])/i;
const cache = new Map();
const metaCache = new Map();
const TTL = 10 * 60 * 1000;
const META_TTL = 6 * 60 * 60 * 1000;

function encodeConcertId(title) {
  return `concert:${Buffer.from(String(title || '').slice(0, 180), 'utf8').toString('base64url')}`;
}

function decodeConcertId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('concert:')) return '';
  try { return Buffer.from(raw.slice(8), 'base64url').toString('utf8'); } catch { return ''; }
}

function cleanConcertTitle(filename) {
  let s = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, ' ');
  s = s.replace(/[._]+/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|dv|dolby|web[- ]?dl|webrip|bluray|brrip|remux|x264|x265|h264|h265|hevc|aac|ac3|eac3|ddp|dts|truehd|atmos|flac|mp3)\b/ig, ' ')
    .replace(/\b(cz|cze|cs|sk|svk|eng|en)\s*(dab|dub|dabing|audio|subs?|tit|titulky)?\b/ig, ' ')
    .replace(/\[[^\]]+\]|\([^\)]*(?:rip|codec|audio|subs?|gb)[^\)]*\)/ig, ' ')
    .replace(/\s+/g, ' ').trim();
  return s.slice(0, 150);
}

function isConcertFile(file) {
  const name = String(file?.name || '');
  if (!CONCERT_RX.test(name)) return false;
  if (file?.ext) return true;
  return VIDEO_RX.test(name) || Number(file?.size || 0) > 200 * 1024 * 1024;
}

function getCached(key) {
  const item = cache.get(key);
  if (!item || Date.now() - item.at > TTL) return null;
  return item.value;
}
function setCached(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
}

function tmdbEnabled() {
  return Boolean(TMDB_API_KEY || TMDB_READ_ACCESS_TOKEN);
}
function tmdbHeaders() {
  if (TMDB_READ_ACCESS_TOKEN) {
    return { Authorization: `Bearer ${TMDB_READ_ACCESS_TOKEN}`, Accept: 'application/json', 'User-Agent': `FastShare-Webshare/${VERSION}` };
  }
  return { Accept: 'application/json', 'User-Agent': `FastShare-Webshare/${VERSION}` };
}
function tmdbUrl(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  if (TMDB_API_KEY) url.searchParams.set('api_key', TMDB_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function concertQuery(title) {
  return String(title || '')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\b(2160p|1080p|720p|4k|uhd|hdr)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a, b) {
  const aa = normalize(a);
  const bb = normalize(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 100;
  if (aa.includes(bb) || bb.includes(aa)) return 85;
  const at = new Set(aa.split(' ').filter(x => x.length > 2));
  const bt = new Set(bb.split(' ').filter(x => x.length > 2));
  if (!at.size || !bt.size) return 0;
  const overlap = [...at].filter(x => bt.has(x)).length;
  return Math.round(100 * overlap / Math.max(at.size, bt.size));
}

async function enrichConcert(item) {
  const key = normalize(item.title || item.filename || '');
  const cached = metaCache.get(key);
  if (cached && Date.now() - cached.at < META_TTL) return cached.value;

  const year = String(item.title || item.filename || '').match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '';
  const fallback = {
    ...item,
    id: encodeConcertId(item.title),
    name: item.title,
    releaseInfo: year,
    description: `Koncert nájdený priamo na ${item.provider}. Zdroj: ${item.filename}`,
    genres: ['Music'],
    poster: undefined,
    background: undefined,
    imdbRating: undefined,
    tmdbId: undefined,
    imdbId: undefined
  };

  if (!tmdbEnabled()) {
    metaCache.set(key, { at: Date.now(), value: fallback });
    return fallback;
  }

  try {
    const query = concertQuery(item.title);
    const search = await fetchJson(tmdbUrl('/search/movie', { query, language: 'cs-CZ', include_adult: 'false' }), { headers: tmdbHeaders() });
    const rows = Array.isArray(search?.results) ? search.results : [];
    const ranked = rows.map(row => {
      const name = row.title || row.original_title || '';
      let score = titleSimilarity(query, name);
      const rowYear = String(row.release_date || '').slice(0, 4);
      if (year && rowYear === year) score += 20;
      if (/\b(concert|live|tour|unplugged|festival|performance)\b/i.test(name)) score += 15;
      return { row, score };
    }).sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best || best.score < 55) {
      metaCache.set(key, { at: Date.now(), value: fallback });
      return fallback;
    }

    const detail = await fetchJson(tmdbUrl(`/movie/${best.row.id}`, { language: 'cs-CZ', append_to_response: 'external_ids' }), { headers: tmdbHeaders() });
    const value = {
      ...fallback,
      name: detail.title || best.row.title || item.title,
      releaseInfo: String(detail.release_date || best.row.release_date || '').slice(0, 4) || year,
      description: detail.overview || fallback.description,
      poster: detail.poster_path ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : undefined,
      background: detail.backdrop_path ? `https://image.tmdb.org/t/p/original${detail.backdrop_path}` : undefined,
      imdbRating: Number(detail.vote_average || 0) ? String(Number(detail.vote_average).toFixed(1)) : undefined,
      genres: Array.isArray(detail.genres) && detail.genres.length ? detail.genres.map(g => g.name) : ['Music'],
      runtime: Number(detail.runtime || 0) ? `${detail.runtime} min` : undefined,
      tmdbId: detail.id,
      imdbId: detail.external_ids?.imdb_id || undefined
    };
    metaCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    metaCache.set(key, { at: Date.now(), value: fallback });
    return fallback;
  }
}

async function discover(runtime, req) {
  const cfg = runtime.unifiedConfig(req);
  const cacheKey = `${cfg.fastshare.username || ''}|${cfg.webshare.username || ''}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const [fa, wa] = await Promise.all([
    fastshareLogin(cfg.fastshare),
    webshareLogin(cfg.webshare)
  ]);

  const [fr, wr] = await Promise.all([
    fa.ok ? mapWithConcurrency(TERMS, 3, term => searchFastshare(term, fa.hash)) : [],
    wa.ok ? mapWithConcurrency(TERMS, 3, term => searchWebshare(term, wa.token)) : []
  ]);

  const rows = [
    ...(fr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'FastShare' }))),
    ...(wr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'Webshare' })))
  ].filter(isConcertFile);

  const byTitle = new Map();
  for (const file of rows) {
    const title = cleanConcertTitle(file.name);
    const key = normalize(title)
      .replace(/\b(19\d{2}|20\d{2})\b/g, '')
      .replace(/\s+/g, ' ').trim();
    if (!title || key.length < 5) continue;
    const prev = byTitle.get(key);
    const size = Number(file.size || 0);
    if (!prev || size > prev.size) byTitle.set(key, { title, size, provider: file.provider, filename: file.name });
  }

  const value = [...byTitle.values()]
    .sort((a, b) => b.size - a.size || a.title.localeCompare(b.title))
    .slice(0, 300);
  setCached(cacheKey, value);
  return value;
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
    try {
      const all = await discover(runtime, req);
      const skip = skipOf(req.params.extra);
      const page = all.slice(skip, skip + 40);
      const enriched = await mapWithConcurrency(page, 5, enrichConcert);
      const metas = enriched.map(item => ({
        id: encodeConcertId(item.title),
        type: 'movie',
        name: item.name || item.title,
        poster: item.poster,
        background: item.background,
        description: item.description,
        releaseInfo: item.releaseInfo,
        imdbRating: item.imdbRating,
        genres: item.genres,
        runtime: item.runtime,
        behaviorHints: { defaultVideoId: encodeConcertId(item.title) }
      }));
      res.set('Cache-Control', 'private, max-age=300');
      console.log('[concert-catalog-direct]', JSON.stringify({ total: all.length, skip, count: metas.length, enriched: metas.filter(m => m.poster || m.background).length }));
      res.json({ metas });
    } catch (error) {
      console.error('[concert-catalog-error]', String(error?.message || error));
      res.json({ metas: [] });
    }
  }

  async function sendMeta(req, res) {
    const title = decodeConcertId(req.params.id);
    if (title) {
      const fakeItem = { title, filename: title, provider: 'FastShare/Webshare', size: 0 };
      const meta = await enrichConcert(fakeItem);
      return res.json({ meta: {
        id: req.params.id,
        type: 'movie',
        name: meta.name || title,
        poster: meta.poster,
        background: meta.background,
        releaseInfo: meta.releaseInfo,
        description: meta.description,
        imdbRating: meta.imdbRating,
        genres: meta.genres,
        runtime: meta.runtime
      }});
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

  return { ...runtime, encodeConcertId, decodeConcertId, discoverConcerts: discover, enrichConcert };
}

module.exports = install;
