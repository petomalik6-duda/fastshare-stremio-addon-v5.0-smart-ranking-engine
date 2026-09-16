'use strict';

const { availableEpisodeDate } = require('./catalog-availability-date');

const { login: webshareLogin, searchWebshareRecent } = require('./webshare');
const { login: fastshareLogin, searchFastshare } = require('./fastshare');
const { TMDB_API_KEY, TMDB_READ_ACCESS_TOKEN, VERSION } = require('./config');
const { fetchJson, mapWithConcurrency, normalize } = require('./utils');
const { getMeta } = require('./metadata');
const { hasCzSkAudio, qualityMatches, preferredLocalizedTitle } = require('./catalogs');

const TARGET_IDS = new Set([
  'unified-czsk-movies',
  'unified-czsk-series',
  'unified-latest-movies',
  'unified-latest-series',
  'unified-4k-czsk'
]);
const CACHE_TTL = Number(process.env.PROVIDER_RECENT_CACHE_TTL_MS || 3 * 60 * 1000);
const cache = new Map();
const { validTimestamp } = require('./catalog-order');

function tmdbEnabled() { return Boolean(TMDB_API_KEY || TMDB_READ_ACCESS_TOKEN); }
function tmdbHeaders() {
  if (TMDB_READ_ACCESS_TOKEN) return { Authorization: `Bearer ${TMDB_READ_ACCESS_TOKEN}`, Accept: 'application/json', 'User-Agent': `FastShare-Webshare/${VERSION}` };
  return { Accept: 'application/json', 'User-Agent': `FastShare-Webshare/${VERSION}` };
}
function tmdbUrl(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  if (TMDB_API_KEY) url.searchParams.set('api_key', TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

function isSeriesFile(name) {
  return /\bS\d{1,2}(?:E\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b|\bseason\s*\d{1,2}\b|\bseria\s*\d{1,2}\b/i.test(String(name || '').replace(/[._]+/g, ' '));
}
function yearOf(name) { return String(name || '').match(/\b(19\d{2}|20\d{2})\b/)?.[0] || ''; }
function cleanTitle(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\bS\d{1,2}(?:E\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b/ig, ' ')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|dolby|web[- ]?dl|webrip|bluray|brrip|hdrip|dvdrip|remux|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|ddp|dd|dts|truehd|atmos|flac|mp3|mkv|mp4|avi)\b/ig, ' ')
    .replace(/\b(cz|cze|cs|ceske|cesky|czech|sk|svk|slovak|slovensky|en|eng|english)\s*(dab|dub|dabing|dubbing|audio|tit|titulky|subs?|subtitle)?\b/ig, ' ')
    .replace(/\b(proper|repack|internal|extended|unrated|complete|multi)\b/ig, ' ')
    .replace(/\[[^\]]+\]|\([^\)]*(?:rip|codec|audio|subs?|gb|mb)[^\)]*\)/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokenScore(a, b) {
  const aa = normalize(a), bb = normalize(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 100;
  if (aa.includes(bb) || bb.includes(aa)) return 88;
  const at = new Set(aa.split(' ').filter(x => x.length > 2));
  const bt = new Set(bb.split(' ').filter(x => x.length > 2));
  if (!at.size || !bt.size) return 0;
  const overlap = [...at].filter(x => bt.has(x)).length;
  return Math.round(100 * overlap / Math.max(at.size, bt.size));
}

async function tmdbSearch(path, query, year, isSeries, withYear) {
  const params = { query, language: 'cs-CZ', include_adult: 'false' };
  if (withYear && year) params[isSeries ? 'first_air_date_year' : 'primary_release_year'] = year;
  try {
    const data = await fetchJson(tmdbUrl(path, params), { headers: tmdbHeaders() });
    return Array.isArray(data?.results) ? data.results : [];
  } catch { return []; }
}

async function matchTmdb(file, type) {
  if (!tmdbEnabled()) return null;
  const query = cleanTitle(file.name);
  if (query.length < 3) return null;
  const year = yearOf(file.name);
  const isSeries = type === 'series';
  const path = isSeries ? '/search/tv' : '/search/movie';
  const [withYear, withoutYear] = await Promise.all([
    tmdbSearch(path, query, year, isSeries, true),
    year ? tmdbSearch(path, query, year, isSeries, false) : Promise.resolve([])
  ]);
  const seen = new Set();
  const rows = [...withYear, ...withoutYear].filter(row => row?.id && !seen.has(row.id) && seen.add(row.id));
  const ranked = rows.map(row => {
    const names = [row.title, row.name, row.original_title, row.original_name].filter(Boolean);
    let score = Math.max(0, ...names.map(name => tokenScore(query, name)));
    const rowYear = String(row.release_date || row.first_air_date || '').slice(0, 4);
    if (year && rowYear === year) score += 18;
    else if (year && rowYear && Math.abs(Number(rowYear) - Number(year)) === 1) score += 6;
    else if (year && rowYear && Math.abs(Number(rowYear) - Number(year)) > 2) score -= 12;
    return { row, score };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 52) return null;
  try {
    const extPath = isSeries ? `/tv/${best.row.id}/external_ids` : `/movie/${best.row.id}/external_ids`;
    const ext = await fetchJson(tmdbUrl(extPath), { headers: tmdbHeaders() });
    const imdbId = String(ext?.imdb_id || '');
    if (!/^tt\d+$/.test(imdbId)) return null;
    const meta = await getMeta(type, imdbId);
    return { imdbId, meta, row: best.row, score: best.score };
  } catch { return null; }
}

function searchTerms(id, type) {
  const nowYear = new Date().getFullYear();
  const prev = nowYear - 1;
  if (id === 'unified-4k-czsk') return ['2160p', '4K', 'UHD', '2160p CZ', '2160p SK', '4K CZ', '4K SK', 'UHD CZ', 'UHD SK'];
  if (id === 'unified-czsk-movies' || id === 'unified-czsk-series') {
    return ['CZ', 'SK', 'CZE', 'SVK', `${nowYear} CZ`, `${nowYear} SK`, 'CZ dabing', 'SK dabing', 'CZ audio', 'SK audio'];
  }
  if (type === 'series') return [String(nowYear), String(prev), 'S01E', 'S02E', 'WEB-DL', '1080p'];
  return [String(nowYear), String(prev), '1080p', '2160p', 'WEB-DL', 'BluRay'];
}

function likelyCzSkRelease(file) {
  if (hasCzSkAudio({ ...file, audio: undefined })) return true;
  const n = normalize(file?.name || '');
  if (!n) return false;
  const subtitle = /\b(cz|cze|cs|cesky|czech|sk|svk|slovak|slovensky)\s*(tit|titulky|sub|subs|subtitle|forced)\b|\b(titulky|subs?|subtitle|forced)\b/.test(n);
  if (subtitle) return false;
  const language = /(^|\s)(cz|cze|cs|cesky|czech|sk|svk|slovak|slovensky)(\s|$)/.test(n);
  const release = /\b(2160p|1080p|720p|4k|uhd|webdl|webrip|bluray|brrip|remux|mkv|mp4|x264|x265|h264|h265|hevc)\b/.test(n);
  return language && release;
}

function eligibleFile(file, id, type) {
  const series = isSeriesFile(file.name);
  if (type === 'series' && !series) return false;
  if (type === 'movie' && series) return false;
  if (id === 'unified-czsk-movies' || id === 'unified-czsk-series' || id === 'unified-4k-czsk') {
    if (!likelyCzSkRelease(file)) return false;
  }
  if (id === 'unified-4k-czsk' && !qualityMatches(file, '2160p')) return false;
  return true;
}

function timestampOf(file) {
  const raw = file?.raw || {};
  for (const value of [file?.created, file?.uploaded, raw.created, raw.uploaded, raw.created_at, raw.uploaded_at, raw.upload_date, raw.added_at]) {
    const time = validTimestamp(value);
    if (time) return time;
  }
  return 0;
}

function collectResponses(responses, provider, limit = 260) {
  const files = [];
  const seen = new Set();
  const maxLen = Math.max(...responses.map(r => (r?.files || []).length), 0);
  for (let i = 0; i < maxLen && files.length < limit; i++) {
    for (const [feedIndex, response] of responses.entries()) {
      const file = response?.files?.[i];
      const key = `${provider}:${file?.id || file?.ident || file?.name || ''}`;
      if (!file || seen.has(key)) continue;
      seen.add(key);
      files.push({ ...file, provider, _providerFeedId: String(feedIndex).padStart(3, '0'), _providerFeedRank: i, _providerSourceRank: files.length, _uploadedAt: timestampOf(file) });
    }
  }
  return files;
}

function mergeProviderFiles(webFiles, fastFiles, id, type) {
  const combined = [...webFiles, ...fastFiles].filter(file => eligibleFile(file, id, type));
  const seen = new Set();
  const unique = [];
  for (const file of combined) {
    const key = `${file.provider}:${file.id || file.ident || file.name || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  unique.sort((a, b) => {
    if (b._uploadedAt !== a._uploadedAt && (a._uploadedAt || b._uploadedAt)) return b._uploadedAt - a._uploadedAt;
    const ap = a.provider === 'webshare' ? 0 : 1;
    const bp = b.provider === 'webshare' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a._providerSourceRank - b._providerSourceRank;
  });
  return unique.slice(0, 300).map((file, index) => ({ ...file, _recentRank: index }));
}

function toCatalogItem(match, type, file, recentRank) {
  const raw = match.meta?.raw || {};
  const releaseDate = String(match.row.release_date || match.row.first_air_date || '');
  return {
    ...raw,
    id: raw.id || match.imdbId,
    type,
    name: preferredLocalizedTitle(match.meta, raw.name || raw.title || cleanTitle(file.name)),
    poster: raw.poster || (match.row.poster_path ? `https://image.tmdb.org/t/p/w500${match.row.poster_path}` : undefined),
    background: raw.background || (match.row.backdrop_path ? `https://image.tmdb.org/t/p/original${match.row.backdrop_path}` : undefined),
    releaseInfo: raw.releaseInfo || releaseDate.slice(0, 4),
    _releaseDate: releaseDate,
    _availableEpisodeDate: type === 'series' ? availableEpisodeDate(match.meta, file.name) : undefined,
    _providerRecentRank: recentRank,
    _providerOrderKind: 'discovery',
    _providerFeedId: file._providerFeedId,
    _providerFeedRank: file._providerFeedRank,
    _audioEvidence: file.audio,
    _nativeLocale: ['cs', 'sk'].includes(match.row.original_language) ? (match.row.original_language === 'cs' ? 'cz' : 'sk') : undefined,
    _providerSource: file.provider,
    _uploadedAt: file._uploadedAt || 0,
    behaviorHints: {
      ...(raw.behaviorHints || {}),
      ...(type === 'movie' ? { defaultVideoId: match.imdbId } : {}),
      filename: file.name
    }
  };
}

async function providerRecent(runtime, req) {
  const id = req.params.id;
  const type = req.params.type;
  const cfg = runtime.unifiedConfig ? runtime.unifiedConfig(req) : {};
  const userKey = `${cfg?.webshare?.username || ''}|${cfg?.fastshare?.username || ''}`;
  const cacheKey = `${userKey}:${type}:${id}:v4`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const [wa, fa] = await Promise.all([
    cfg?.webshare?.username && cfg?.webshare?.password ? webshareLogin(cfg.webshare) : Promise.resolve({ ok: false, error: 'missing credentials' }),
    cfg?.fastshare?.username && cfg?.fastshare?.password ? fastshareLogin(cfg.fastshare) : Promise.resolve({ ok: false, error: 'missing credentials' })
  ]);
  const terms = searchTerms(id, type);
  const [webResponses, fastResponses] = await Promise.all([
    wa.ok ? mapWithConcurrency(terms, 4, term => searchWebshareRecent(term, wa.token, { limit: 160 })) : Promise.resolve([]),
    fa.ok ? mapWithConcurrency(terms, 4, term => searchFastshare(term, fa.hash)) : Promise.resolve([])
  ]);
  const webFiles = collectResponses(webResponses, 'webshare');
  const fastFiles = collectResponses(fastResponses, 'fastshare');
  const files = mergeProviderFiles(webFiles, fastFiles, id, type);

  const matches = await mapWithConcurrency(files.slice(0, 220), 7, file => matchTmdb(file, type).then(match => match ? { file, match } : null));
  const metas = [];
  for (const item of matches) {
    if (!item) continue;
    metas.push(toCatalogItem(item.match, type, item.file, item.file._recentRank));
  }
  const value = {
    metas,
    filesScanned: files.length,
    matched: metas.length,
    webshareFiles: webFiles.length,
    fastshareFiles: fastFiles.length,
    auth: { webshare: Boolean(wa.ok), fastshare: Boolean(fa.ok) },
    webshareAuthStatus: wa.ok ? 'ok' : (!cfg?.webshare?.username || !cfg?.webshare?.password) ? 'missing-credentials' : 'login-failed',
    source: wa.ok && fa.ok ? 'webshare-recent+fastshare' : wa.ok ? 'webshare-recent' : fa.ok ? 'fastshare-fallback' : 'none'
  };
  console.log('[provider-native-scan]', JSON.stringify({ id, type, ...value.auth, source: value.source, webshareFiles: value.webshareFiles, fastshareFiles: value.fastshareFiles, eligibleFiles: files.length, matched: metas.length, webshareAuthStatus: value.webshareAuthStatus }));
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function install(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;
  const paths = new Set([
    '/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'
  ]);
  app._router.stack = app._router.stack.filter(layer => !layer.route || !paths.has(layer.route.path));

  async function sendCatalog(req, res) {
    if (!TARGET_IDS.has(req.params.id)) return runtime.sendCatalog(req, res);
    try {
      const recent = await providerRecent(runtime, req);
      if (recent?.metas?.length) {
        res.set('Cache-Control', 'private, no-store');
        console.log('[provider-recent-catalog]', JSON.stringify({ id: req.params.id, type: req.params.type, filesScanned: recent.filesScanned, matched: recent.matched, source: recent.source }));
        return res.json({ metas: recent.metas });
      }
    } catch (error) {
      console.error('[provider-recent-catalog-error]', String(error?.message || error));
    }
    return runtime.sendCatalog(req, res);
  }

  app.get('/catalog/:type/:id.json', sendCatalog);
  app.get('/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/:config/catalog/:type/:id.json', sendCatalog);
  app.get('/:config/catalog/:type/:id/:extra.json', sendCatalog);

  return { ...runtime, sendCatalog, buildProviderRecentCatalog: req => providerRecent(runtime, req) };
}

module.exports = install;
