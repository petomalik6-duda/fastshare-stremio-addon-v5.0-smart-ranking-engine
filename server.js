const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const VERSION = '6.3.4';
const API = 'https://fastshare.cz/api/api_kodi.php';
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 60);
const MAX_SEARCH_TERMS = Number(process.env.MAX_SEARCH_TERMS || 24);
const MAX_TITLE_ALIASES = Number(process.env.MAX_TITLE_ALIASES || 12);
const SEARCH_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.SEARCH_CONCURRENCY || 3)));
const METADATA_NEGATIVE_CACHE_TTL_MS = Number(process.env.METADATA_NEGATIVE_CACHE_TTL_MS || 1000 * 60 * 60 * 6);
const METADATA_CACHE_TTL_MS = Number(process.env.METADATA_CACHE_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const METADATA_CACHE_MAX = Number(process.env.METADATA_CACHE_MAX || 2000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 9000);
const TMDB_API_KEY = String(process.env.TMDB_API_KEY || '').trim();
const TMDB_READ_ACCESS_TOKEN = String(process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_BEARER_TOKEN || process.env.TMDB_TOKEN || '').trim();
const ENABLE_WIKIDATA_ALIASES = String(process.env.ENABLE_WIKIDATA_ALIASES || '1') !== '0';

// Localized aliases are fetched automatically for every IMDb title. The built-in
// table remains only as an emergency fallback for verified edge cases. Additional
// aliases can be supplied through TITLE_ALIASES_JSON env as:
// {"tt1234567":["Czech title","Slovak title"]}
const BUILTIN_TITLE_ALIASES = Object.freeze({
  tt33612209: [
    'The Devil Wears Prada 2',
    'Dabel nosi Pradu 2',
    'Diabol nosi Pradu 2'
  ]
});

function loadEnvTitleAliases() {
  try {
    const parsed = JSON.parse(process.env.TITLE_ALIASES_JSON || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [id, aliases] of Object.entries(parsed)) {
      if (!/^tt\d+$/.test(id) || !Array.isArray(aliases)) continue;
      out[id] = aliases.filter(x => typeof x === 'string' && x.trim()).slice(0, 20);
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_TITLE_ALIASES = loadEnvTitleAliases();

const authCache = new Map();
const localizedMetaCache = new Map();

function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function b64urlDecode(str) {
  try { return JSON.parse(Buffer.from(str, 'base64url').toString('utf8')); } catch { return {}; }
}
function safeText(v) { return String(v || '').replace(/[<>]/g, ''); }
function normalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}
function uniqueSearchTerms(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const key = text.toLocaleLowerCase('en-US');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}
function levenshtein(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
function fuzzyTokenMatch(expected, actual) {
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if (expected.length >= 5 && actual.length >= 5 && expected.slice(0, 4) === actual.slice(0, 4)) return true;
  const maxLen = Math.max(expected.length, actual.length);
  return maxLen >= 4 && Math.abs(expected.length - actual.length) <= 1 && levenshtein(expected, actual) <= 1;
}
function extractAliasValues(raw) {
  const values = [];
  const keys = ['name', 'title', 'originalName', 'originalTitle', 'localizedTitle', 'localTitle'];
  for (const key of keys) if (raw && typeof raw[key] === 'string') values.push(raw[key]);
  const listKeys = ['aliases', 'alternativeTitles', 'alternateTitles', 'aka', 'akas'];
  for (const key of listKeys) {
    const list = raw && raw[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') values.push(item);
      else if (item && typeof item === 'object') values.push(item.title, item.name);
    }
  }
  return values.filter(Boolean);
}
function getTitleAliases(meta) {
  const imdbId = String(meta?.imdbId || '').split(':')[0];
  return uniqueStrings([
    ...(ENV_TITLE_ALIASES[imdbId] || []),
    ...(BUILTIN_TITLE_ALIASES[imdbId] || []),
    ...(meta?.localizedAliases || []),
    meta?.title,
    ...extractAliasValues(meta?.raw || {})
  ]).slice(0, MAX_TITLE_ALIASES);
}

function trimCache(map, maxEntries = METADATA_CACHE_MAX) {
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}
function getFreshCache(map, key, ttl = METADATA_CACHE_TTL_MS) {
  const entry = map.get(key);
  if (!entry) return null;
  const expiresAt = entry.expiresAt || (entry.ts + ttl);
  if (Date.now() > expiresAt) {
    map.delete(key);
    return null;
  }
  map.delete(key);
  map.set(key, entry);
  return entry.value;
}
function setCache(map, key, value, ttl = METADATA_CACHE_TTL_MS) {
  map.delete(key);
  const ts = Date.now();
  map.set(key, { value, ts, expiresAt: ts + ttl });
  trimCache(map);
}
function safeUrlForError(value) {
  try {
    const url = new URL(String(value));
    for (const key of ['api_key', 'token', 'access_token', 'session', 'password', 'login']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[redacted]');
    }
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return '[invalid-url]';
  }
}
async function fetchJson(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${safeUrlForError(url)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
function addAlias(out, value, source, language = '') {
  const title = String(value || '').trim();
  if (!title) return;
  const key = normalize(title);
  if (!key) return;
  const current = out.get(key);
  if (!current) out.set(key, { title, source, language });
  else if (!current.language && language) out.set(key, { title, source, language });
}
function extractTmdbLocalizedAliases(type, payloads = []) {
  const out = new Map();
  for (const payload of payloads.filter(Boolean)) {
    addAlias(out, payload.title, 'tmdb', payload.__language || '');
    addAlias(out, payload.name, 'tmdb', payload.__language || '');
    addAlias(out, payload.original_title, 'tmdb', 'original');
    addAlias(out, payload.original_name, 'tmdb', 'original');
    const alternative = payload.alternative_titles || payload.alternativeTitles || {};
    const titles = alternative.titles || alternative.results || [];
    for (const item of Array.isArray(titles) ? titles : []) {
      const country = String(item.iso_3166_1 || '').toUpperCase();
      if (!country || ['CZ', 'SK', 'CS'].includes(country)) addAlias(out, item.title || item.name, 'tmdb-alt', country.toLowerCase());
    }
    const translations = payload.translations?.translations || payload.translations || [];
    for (const item of Array.isArray(translations) ? translations : []) {
      const lang = String(item.iso_639_1 || '').toLowerCase();
      const country = String(item.iso_3166_1 || '').toUpperCase();
      if (!['cs', 'sk'].includes(lang) && !['CZ', 'SK', 'CS'].includes(country)) continue;
      addAlias(out, item.data?.title || item.data?.name, 'tmdb-translation', lang || country.toLowerCase());
    }
  }
  return [...out.values()];
}
function extractWikidataLocalizedAliases(payload) {
  const out = new Map();
  const rows = payload?.results?.bindings || [];
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const key of ['label', 'altLabel', 'title']) {
      const cell = row?.[key];
      const lang = String(cell?.['xml:lang'] || '').toLowerCase();
      if (lang && !['cs', 'sk', 'en'].includes(lang)) continue;
      addAlias(out, cell?.value, 'wikidata', lang);
    }
  }
  return [...out.values()];
}
function tmdbRequestOptions() {
  const headers = { Accept: 'application/json', 'User-Agent': 'FastShare-Stremio-Addon/6.3.4' };
  if (TMDB_READ_ACCESS_TOKEN) headers.Authorization = `Bearer ${TMDB_READ_ACCESS_TOKEN}`;
  return { headers };
}
function tmdbUrl(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== '' && value != null) url.searchParams.set(key, value);
  if (TMDB_API_KEY && !TMDB_READ_ACCESS_TOKEN) url.searchParams.set('api_key', TMDB_API_KEY);
  return url.toString();
}
async function fetchTmdbAliases(type, imdbId) {
  if (!TMDB_API_KEY && !TMDB_READ_ACCESS_TOKEN) return { aliases: [], source: 'tmdb-disabled' };
  const find = await fetchJson(tmdbUrl(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' }), tmdbRequestOptions());
  const isSeries = type === 'series';
  const hit = isSeries ? find.tv_results?.[0] : find.movie_results?.[0];
  if (!hit?.id) return { aliases: [], source: 'tmdb-not-found' };
  const mediaPath = isSeries ? `/tv/${hit.id}` : `/movie/${hit.id}`;
  const [cs, sk] = await Promise.all([
    fetchJson(tmdbUrl(mediaPath, { language: 'cs-CZ', append_to_response: 'alternative_titles,translations' }), tmdbRequestOptions()).then(x => ({ ...x, __language: 'cs' })),
    fetchJson(tmdbUrl(mediaPath, { language: 'sk-SK', append_to_response: 'alternative_titles,translations' }), tmdbRequestOptions()).then(x => ({ ...x, __language: 'sk' }))
  ]);
  return { aliases: extractTmdbLocalizedAliases(type, [hit, cs, sk]), source: 'tmdb', tmdbId: hit.id };
}
async function fetchWikidataAliases(imdbId) {
  if (!ENABLE_WIKIDATA_ALIASES) return { aliases: [], source: 'wikidata-disabled' };
  const safeId = String(imdbId || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!/^tt\d+$/.test(safeId)) return { aliases: [], source: 'wikidata-invalid-id' };
  const query = `SELECT ?item ?label ?altLabel ?title WHERE {
    ?item wdt:P345 "${safeId}" .
    OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) IN ("cs", "sk", "en", "")) }
    OPTIONAL { ?item skos:altLabel ?altLabel . FILTER(LANG(?altLabel) IN ("cs", "sk", "en", "")) }
    OPTIONAL { ?item wdt:P1476 ?title . FILTER(LANG(?title) IN ("cs", "sk", "en", "")) }
  } LIMIT 120`;
  const url = new URL('https://query.wikidata.org/sparql');
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');
  const payload = await fetchJson(url.toString(), { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'FastShare-Stremio-Addon/6.3.4 (localized title lookup)' } });
  return { aliases: extractWikidataLocalizedAliases(payload), source: 'wikidata' };
}
async function getLocalizedTitleData(type, imdbId) {
  const cacheKey = `${type}:${imdbId}`;
  const cached = getFreshCache(localizedMetaCache, cacheKey);
  if (cached) return { ...cached, cache: 'hit' };

  const sources = [];
  const aliases = [];
  let tmdbId = null;
  const tasks = [
    fetchTmdbAliases(type, imdbId).catch(error => ({ aliases: [], source: 'tmdb-error', error: String(error.message || error) })),
    fetchWikidataAliases(imdbId).catch(error => ({ aliases: [], source: 'wikidata-error', error: String(error.message || error) }))
  ];
  for (const result of await Promise.all(tasks)) {
    sources.push({ source: result.source, count: result.aliases?.length || 0, ...(result.error ? { error: result.error } : {}) });
    aliases.push(...(result.aliases || []));
    if (result.tmdbId) tmdbId = result.tmdbId;
  }
  const values = uniqueStrings(aliases.map(x => x.title));
  const value = { aliases: values, aliasDetails: aliases, sources, tmdbId, cache: 'miss' };
  const ttl = values.length ? METADATA_CACHE_TTL_MS : METADATA_NEGATIVE_CACHE_TTL_MS;
  setCache(localizedMetaCache, cacheKey, value, ttl);
  return value;
}
function extractSequelNumber(value) {
  const raw = String(value || '')
    .replace(/\b(?:ddp?|aac|ac3|dts)[ ._-]?(?:2|5|7)[ ._-]?1\b/gi, ' ')
    .replace(/\b(?:x|h)[ ._-]?26[45]\b/gi, ' ');
  const n = normalize(raw)
    .replace(/\b(19\d{2}|20\d{2}|2160p|1080p|720p|480p)\b/g, ' ')
    .replace(/\b(cz|cze|sk|svk|en|eng|dabing|dubbing|dub|web|webrip|webdl|bluray|brrip|hdr|mkv|mp4|avi)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const patterns = [
    /\b(?:part|chapter|cast|dil|film)\s*(\d{1,2})\b/,
    /\b(?:part|chapter)\s*(ii|iii|iv|v)\b/,
    /\b(\d{1,2})\s*$/,
    /\b(ii|iii|iv|v)\s*$/
  ];
  for (const rx of patterns) {
    const m = n.match(rx);
    if (!m) continue;
    const token = m[1];
    if (/^\d+$/.test(token)) return Number(token);
    return ({ ii: 2, iii: 3, iv: 4, v: 5 })[token] || 0;
  }
  const standalone = [...n.matchAll(/\b([2-5])\b/g)];
  if (standalone.length) return Number(standalone[standalone.length - 1][1]);
  return 0;
}
function slug(s) { return normalize(s).replace(/\s+/g, '-'); }
function esc(s) { return encodeURIComponent(String(s || '')); }
function bytesToHuman(bytes) {
  const n = Number(bytes || 0); if (!n) return '';
  const units = ['B','KB','MB','GB','TB']; let x = n, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return i < 2 ? `${Math.round(x)} ${units[i]}` : `${x.toFixed(x >= 10 ? 0 : 1)} ${units[i]}`;
}
function parseRuntimeSeconds(meta) {
  const r = meta && (meta.runtime || meta.raw?.runtime);
  const m = String(r || '').match(/(\d+)\s*min/i);
  return m ? Number(m[1]) * 60 : 0;
}
function getExt(name) {
  const m = String(name || '').match(/\.([a-z0-9]{2,5})(?:$|[\s\]\)])/i);
  if (!m) return '';
  const ext = m[1].toUpperCase();
  return ['MKV','MP4','AVI','MOV','M4V'].includes(ext) ? ext : '';
}
function detectQuality(name) {
  const n = normalize(name);
  if (/\b(2160p|4k|uhd|uhdr)\b/.test(n)) return '4K';
  if (/\b(1080p|fullhd|fhd)\b/.test(n)) return '1080p';
  if (/\b720p\b/.test(n)) return '720p';
  if (/\b(480p|sd)\b/.test(n)) return '480p';
  return '';
}
function detectAudio(name) {
  const n = normalize(name);
  const raw = String(name || '').toLowerCase();

  // Subtitles must be detected before generic CZ/SK tokens.
  // Important: "CZ tit/subs/title/forced" is NOT CZ audio.
  const czSubs = /\b(cz|cze|cs|ceske|cesky|czech)\s*(tit|titulky|sub|subs|subtitle|forced|title)\b|cztit|czforced/.test(n);
  const skSubs = /\b(sk|svk|slovak|slovensky)\s*(tit|titulky|sub|subs|subtitle|forced|title)\b|sktit|skforced/.test(n);

  const czDubStrong = /czdab|\b(cz|cze|cs|ceske|cesky)\s*(dab|dub|dabing|dubbing|audio)\b|\b(czech)\s*(audio|dub|dubbing)\b/.test(n);
  const skDubStrong = /skdab|\b(sk|svk|slovak|slovensky)\s*(dab|dub|dabing|dubbing|audio)\b|\b(slovak)\s*(audio|dub|dubbing)\b/.test(n);
  const enStrong = /\b(en|eng|english)\s*(audio|dab|dub|dabing|dubbing)\b|\b(en|eng)\s*dabing\b/.test(n);

  const hasCZ = /(^|[^a-z])(cz|cze|cs|cesky|czech)([^a-z]|$)/.test(n) || /czhd/i.test(raw);
  const hasSK = /(^|[^a-z])(sk|svk|slovak|slovensky)([^a-z]|$)/.test(n);
  const hasEN = /(^|[^a-z])(en|eng|english)([^a-z]|$)/.test(n);
  const explicitMulti = /multi\s*audio|dual\s*audio|dual/.test(n);
  const genericDub = /\b(dab|dub|dabing|dubbing|dubbed)\b/.test(n);

  let label = 'Audio neznáme', key = 'any', score = 0;

  if (czDubStrong && skDubStrong) { label = 'CZ/SK Dabing'; key = 'CZ-SK'; score = 105; }
  else if (czDubStrong) { label = 'CZ Dabing'; key = 'CZ'; score = 100; }
  else if (skDubStrong) { label = 'SK Dabing'; key = 'SK'; score = 80; }
  else if (hasCZ && hasEN && !czSubs) { label = 'CZ/EN Audio'; key = 'CZ-EN'; score = 85; }
  else if (hasSK && hasEN && !skSubs) { label = 'SK/EN Audio'; key = 'SK-EN'; score = 55; }
  else if (enStrong || hasEN) { label = 'EN Audio'; key = 'EN'; score = 40; }
  else if (explicitMulti) { label = 'Multi Audio'; key = 'multi'; score = 30; }
  else if (genericDub) { label = 'Dabing – jazyk neznámy'; key = 'dub'; score = 55; }
  else if (czSubs) { label = 'CZ titulky'; key = 'sub'; score = 5; }
  else if (skSubs) { label = 'SK titulky'; key = 'sub'; score = 5; }
  else if (hasCZ) { label = 'CZ neoverené'; key = 'CZ'; score = 20; }
  else if (hasSK) { label = 'SK neoverené'; key = 'SK'; score = 15; }

  const subs = [];
  if (czSubs && label !== 'CZ titulky') subs.push('CZ titulky');
  if (skSubs && label !== 'SK titulky') subs.push('SK titulky');
  const subScore = (czSubs && label !== 'CZ titulky' ? 15 : 0) + (skSubs && label !== 'SK titulky' ? 10 : 0);
  return { label, key, score, subs, subScore };
}
function hasEpisodePattern(name) {
  return /\bS\d{1,2}E\d{1,2}\b/i.test(name) || /\b\d{1,2}x\d{1,2}\b/i.test(name);
}
function episodePatternScore(name, meta) {
  if (meta.type !== 'series' || !meta.season || !meta.episode) return { score: 0, reason: null };
  const raw = String(name || '');
  const n = normalize(raw);
  const s = Number(meta.season);
  const e = Number(meta.episode);
  const sp = String(s).padStart(2, '0');
  const ep = String(e).padStart(2, '0');

  const patterns = [
    new RegExp('\\bs0?' + s + 'e0?' + e + '\\b', 'i'),
    new RegExp('\\b0?' + s + 'x0?' + e + '\\b', 'i'),
    new RegExp('\\bseries\\s*0?' + s + '\\s*episode\\s*0?' + e + '\\b', 'i'),
    new RegExp('\\bseason\\s*0?' + s + '\\s*episode\\s*0?' + e + '\\b', 'i')
  ];
  if (patterns.some(rx => rx.test(raw) || rx.test(n))) return { score: 180, reason: 'episode-pattern +180' };

  // Weaker Czech/Slovak style fallback: title ... 01 02 / ep 02
  if (new RegExp('\\b(ep|dil|cast|epizoda)\\s*0?' + e + '\\b', 'i').test(n)) {
    return { score: 80, reason: 'episode-number +80' };
  }
  return { score: 0, reason: null };
}
function seriesEpisodeMismatch(name, meta) {
  if (meta.type !== 'series' || !meta.season || !meta.episode) return false;
  const raw = String(name || '');
  const n = normalize(raw);
  const s = Number(meta.season);
  const e = Number(meta.episode);

  const se = raw.match(/\bS(\d{1,2})E(\d{1,2})\b/i) || raw.match(/\b(\d{1,2})x(\d{1,2})\b/i);
  if (!se) return false;
  const fs = Number(se[1]);
  const fe = Number(se[2]);
  return fs !== s || fe !== e;
}
function getYears(name) {
  return [...String(name || '').matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => m[1]);
}
function sequelMismatch(name, meta, aliases = getTitleAliases(meta)) {
  const expected = aliases.map(extractSequelNumber).find(n => n >= 2 && n <= 5) || 0;
  if (!expected) return false;

  const candidate = extractSequelNumber(name);
  if (candidate && candidate !== expected) return true;

  // A translated filename may omit the sequel number, but a matching release
  // year is sufficient evidence. A clearly different year is the original film.
  if (!candidate) {
    const metaYear = String(meta.year || meta.releaseInfo || '').match(/\d{4}/)?.[0] || '';
    const years = getYears(name);
    if (metaYear && years.length && !years.includes(metaYear)) return true;
  }
  return false;
}
const GENERIC_MEDIA_TITLE_TOKENS = new Set([
  'live', 'concert', 'tour', 'show', 'performance', 'special', 'edition',
  'version', 'complete', 'full', 'movie', 'film', 'video', 'collection'
]);

function aliasMatchScore(fileName, alias) {
  const file = normalize(fileName);
  const title = normalize(alias);
  if (!title) return { score: -80, strong: false, ratio: 0, matched: 0, total: 0, strictShortTitle: false, distinctiveMatched: 0, distinctiveTotal: 0 };

  const stop = new Set(['the','a','an','and','or','of','to','in','on','at','with','for','from']);
  const titleTokens = title.split(' ').filter(x => (x.length > 1 || /^\d+$/.test(x)) && !stop.has(x));
  const lexicalTokens = titleTokens.filter(x => !/^\d+$/.test(x));
  const distinctiveTokens = lexicalTokens.filter(x => !GENERIC_MEDIA_TITLE_TOKENS.has(x));
  const strictShortTitle = lexicalTokens.length === 1;
  const fileTokens = file.split(' ').filter(Boolean);
  const used = new Set();
  let matched = 0;
  let distinctiveMatched = 0;

  for (const expected of titleTokens) {
    const isNumber = /^\d+$/.test(expected);
    const index = fileTokens.findIndex((actual, i) => {
      if (used.has(i)) return false;
      // One-word movie names are highly ambiguous. A one-character fuzzy match
      // such as Tuner -> Tunes must never count as the requested title.
      if (strictShortTitle || isNumber) return expected === actual;
      return fuzzyTokenMatch(expected, actual);
    });
    if (index >= 0) {
      used.add(index);
      matched++;
      if (!isNumber && !GENERIC_MEDIA_TITLE_TOKENS.has(expected)) distinctiveMatched++;
    }
  }

  const total = titleTokens.length;
  const distinctiveTotal = distinctiveTokens.length;
  const ratio = total ? matched / total : 0;
  const exactPhrase = strictShortTitle
    ? total > 0 && matched === total
    : title.length >= 4 && file.includes(title);

  // Two generic/common words must not make a long title a strong match. For
  // concert releases, "Sade + Live" is not enough for "Sade: Bring Me Home -
  // Live 2011"; the distinctive subtitle words must also be present.
  const enoughDistinctive = distinctiveTotal === 0 || distinctiveMatched >= Math.min(2, distinctiveTotal);
  const strong = exactPhrase || matched === total || ratio >= 0.67 || (matched >= 2 && ratio >= 0.5 && enoughDistinctive);

  let score = -80;
  if (exactPhrase) score = 130;
  else if (total && matched === total) score = 110;
  else if (ratio >= 0.67) score = 75;
  else if (matched >= 2) score = 45;
  else if (matched === 1) score = 15;

  return { score, strong, ratio, matched, total, strictShortTitle, distinctiveMatched, distinctiveTotal };
}
function titleMatchScore(fileName, meta, type) {
  const aliases = getTitleAliases(meta);
  const year = String(meta.year || meta.releaseInfo || '').match(/\d{4}/)?.[0] || '';
  const acceptedYears = uniqueStrings([year, ...aliases.flatMap(getYears)]).filter(x => /^(19|20)\d{2}$/.test(x));
  let score = 0, reasons = [];

  if (type === 'movie' && hasEpisodePattern(fileName)) {
    return { reject: true, score: -999, reasons: ['movie-episode-pattern reject'] };
  }
  if (type === 'series' && seriesEpisodeMismatch(fileName, meta)) {
    return { reject: true, score: -999, reasons: ['series-episode-mismatch reject'] };
  }
  if (sequelMismatch(fileName, meta, aliases)) {
    return { reject: true, score: -999, reasons: ['sequel-mismatch reject'] };
  }

  const candidates = aliases.map(alias => ({ alias, ...aliasMatchScore(fileName, alias) }));
  const best = candidates.sort((a, b) => b.score - a.score || b.ratio - a.ratio)[0] || { alias: meta.title || '', score: -80, strong: false, matched: 0, total: 0 };

  // A movie result must have a meaningful title match. Previously a completely
  // unrelated filename could survive only because CZ audio and high quality
  // added enough points. Series retain their episode-pattern fallback below.
  if (type === 'movie' && !best.strong) {
    return { reject: true, score: -999, reasons: ['weak-title-match reject'] };
  }

  const strongTitle = best.strong;
  score += best.score;
  if (best.score >= 110) reasons.push(`title-alias-exact +${best.score} (${best.alias})`);
  else if (best.score > 0) reasons.push(`title-alias-partial +${best.score} (${best.matched}/${best.total})`);
  else reasons.push('title-miss -80');

  const years = getYears(fileName);
  if (acceptedYears.length) {
    if (years.some(y => acceptedYears.includes(y))) {
      score += 50; reasons.push('year/title-year +50');
    } else if (years.length) {
      const fileYear = Number(years[0]);
      const diff = Math.min(...acceptedYears.map(y => Math.abs(fileYear - Number(y))));

      // General release-year fix: if the title is a strong match, do not reject only
      // because Cinemeta/TMDB uses a different release year than the filename.
      if (strongTitle && diff === 1) { score -= 20; reasons.push('year off by 1 strong-title -20'); }
      else if (strongTitle && diff <= 2) { score -= 45; reasons.push('year off by 2 strong-title -45'); }
      else if (strongTitle) { score -= 90; reasons.push('different-year strong-title -90'); }
      else { return { reject: true, score: -999, reasons: ['different-year weak-title reject'] }; }
    }
  }
  const eps = episodePatternScore(fileName, meta);
  if (eps.score) { score += eps.score; reasons.push(eps.reason); }

  // For series, an exact episode pattern is often more reliable than title words,
  // because FastShare may use translated series names.
  if (type === 'series' && eps.score && reasons.includes('title-miss -80')) {
    score += 60;
    reasons.push('series-title-relaxed +60');
  }

  return { reject: false, score, reasons };
}
function runtimeScore(file, meta) {
  const expected = parseRuntimeSeconds(meta);
  const dur = Number(file.duration || file.raw?.duration?.value || 0);
  if (!expected || !dur) return { score: 0, reason: null };
  const diff = Math.abs(dur - expected);
  if (diff <= 180) return { score: 25, reason: 'runtime exact +25' };
  if (diff <= 1500) return { score: 15, reason: 'runtime close +15' };
  if (diff >= 3000) return { score: -50, reason: 'runtime far -50' };
  return { score: 0, reason: null };
}
function qualityScore(q) {
  if (q === '4K') return [30, '4K +30'];
  if (q === '1080p') return [20, '1080p +20'];
  if (q === '720p') return [10, '720p +10'];
  if (q === '480p') return [-5, '480p -5'];
  return [0, null];
}
function extScore(ext) {
  if (ext === 'MKV') return [10, 'MKV +10'];
  if (ext === 'MP4') return [8, 'MP4 +8'];
  if (ext === 'AVI') return [-3, 'AVI -3'];
  return [0, null];
}
function sizeScore(bytes) {
  const gb = Number(bytes || 0) / 1024 / 1024 / 1024;
  if (gb > 15) return [25, 'size >15GB +25'];
  if (gb > 10) return [20, 'size >10GB +20'];
  if (gb > 6) return [15, 'size >6GB +15'];
  if (gb > 3) return [10, 'size >3GB +10'];
  if (gb > 1) return [5, 'size >1GB +5'];
  if (gb && gb < 0.4) return [-40, 'size too small -40'];
  return [0, null];
}
function badQualityPenalty(name) {
  const n = normalize(name);
  if (/\b(cam|hdcam|ts|telesync|tc|workprint|trailer|sample)\b/.test(n)) return [-120, 'bad-release -120'];
  return [0, null];
}
function scoreFile(file, meta, type) {
  const name = file.name || file.filename || file.raw?.filename || '';
  const m = titleMatchScore(name, meta, type);
  if (m.reject) return null;
  let score = m.score; const reasons = [...m.reasons];
  const audio = detectAudio(name); score += audio.score + audio.subScore; reasons.push(`${audio.label} +${audio.score}`); if (audio.subScore) reasons.push(`subtitles +${audio.subScore}`);
  const q = detectQuality(name); const [qs, qr] = qualityScore(q); score += qs; if (qr) reasons.push(qr);
  const ext = getExt(name); const [es, er] = extScore(ext); score += es; if (er) reasons.push(er);
  const [ss, sr] = sizeScore(file.size || file.raw?.data?.value); score += ss; if (sr) reasons.push(sr);
  const rt = runtimeScore(file, meta); score += rt.score; if (rt.reason) reasons.push(rt.reason);
  const [bp, br] = badQualityPenalty(name); score += bp; if (br) reasons.push(br);
  return { ...file, score, scoreReasons: reasons, audio, quality: q, ext };
}
function dedupe(files) {
  const map = new Map();
  for (const f of files) {
    const nameKey = normalize(f.name).replace(/\b(2160p|1080p|720p|480p|4k|uhd|fullhd|fhd|mkv|mp4|avi|cz|sk|en|eng|cze|dabing|dab|extended|cut)\b/g, '').replace(/\s+/g, ' ').trim();
    const key = `${nameKey}|${f.quality}|${f.audio.key}`;
    if (!map.has(key) || f.score > map.get(key).score) map.set(key, f);
  }
  return [...map.values()];
}
function manifest(configToken = null) {
  const prefix = configToken ? `/${configToken}` : '';
  return {
    id: 'community.fastshare.kodiapi.configurator.v6',
    version: VERSION,
    name: 'FastShare Kodi API',
    description: 'FastShare streams using FastShare Kodi API. Configure with your own lawful account.',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: [{ name: 'stream', types: ['movie','series'], idPrefixes: ['tt', ''] }],
    types: ['movie','series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true, configurationRequired: !configToken },
    config: [{ key: 'username', type: 'text', title: 'FastShare username' }, { key: 'password', type: 'password', title: 'FastShare password' }]
  };
}
function getCredentials(req) {
  const token = req.params.config;
  const cfg = token ? b64urlDecode(token) : {};
  return {
    username: cfg.username || process.env.FASTSHARE_USERNAME || '',
    password: cfg.password || process.env.FASTSHARE_PASSWORD || '',
    token: token || null
  };
}
async function login(creds) {
  const username = creds.username, password = creds.password;
  if (!username || !password) return { ok: false, error: 'missing credentials' };
  const cacheKey = crypto.createHash('sha1').update(username + ':' + password).digest('hex');
  const cached = authCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 1000 * 60 * 55) return { ok: true, hash: cached.hash, source: 'cache' };
  const url = `${API}?process=login&login=${esc(username)}&password=${esc(password)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Kodi/20 FastShare Stremio' } });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = null; }
  const hash = json?.user?.hash || json?.hash || json?.data?.hash;
  if (!hash) return { ok: false, status: res.status, preview: txt.slice(0, 300) };
  authCache.set(cacheKey, { hash, ts: Date.now() });
  return { ok: true, hash, source: 'login', status: res.status };
}
async function getMeta(type, id) {
  const parts = String(id || '').split(':');
  const clean = parts[0];
  if (!clean.startsWith('tt')) return { type, imdbId: clean, stremioId: id, title: clean, year: '', season: parts[1] ? Number(parts[1]) : null, episode: parts[2] ? Number(parts[2]) : null, raw: {}, localizedAliases: [], localizedTitleData: { sources: [] } };

  const cinemetaPromise = (async () => {
    try {
      const url = `https://v3-cinemeta.strem.io/meta/${type}/${clean}.json`;
      const json = await fetchJson(url, { headers: { 'User-Agent': 'FastShare-Stremio-Addon/6.3.4' } });
      return json.meta || {};
    } catch (error) {
      return { name: clean, metadataError: String(error.message || error) };
    }
  })();
  const localizedPromise = getLocalizedTitleData(type, clean);
  const [meta, localized] = await Promise.all([cinemetaPromise, localizedPromise]);
  return {
    type,
    imdbId: clean,
    stremioId: id,
    title: meta.name || meta.title || clean,
    year: String(meta.year || meta.releaseInfo || '').slice(0, 4),
    season: parts[1] ? Number(parts[1]) : null,
    episode: parts[2] ? Number(parts[2]) : null,
    raw: meta,
    localizedAliases: localized.aliases,
    localizedTitleData: localized
  };
}
function significantTitleTokens(title) {
  const stop = new Set(['the','a','an','and','or','of','to','in','on','at','with','for','from']);
  return normalize(title).split(' ').filter(x => (x.length > 2 || /^\d+$/.test(x)) && !stop.has(x));
}
function movieTermsFor(meta) {
  const aliases = getTitleAliases(meta);
  const year = String(meta.year || '').match(/\d{4}/)?.[0] || '';
  const full = [], withYear = [], normalizedTitles = [], distinctive = [], stems = [];

  for (const alias of aliases) {
    const tokens = significantTitleTokens(alias);
    const sequel = extractSequelNumber(alias);
    const asciiAlias = normalize(alias);
    full.push(alias);
    if (asciiAlias && asciiAlias.toLocaleLowerCase('en-US') !== String(alias).toLocaleLowerCase('en-US')) full.push(asciiAlias);
    if (year && getYears(alias).length === 0) {
      withYear.push(`${alias} ${year}`);
      if (asciiAlias && asciiAlias.toLocaleLowerCase('en-US') !== String(alias).toLocaleLowerCase('en-US')) withYear.push(`${asciiAlias} ${year}`);
    }
    if (tokens.length >= 2) normalizedTitles.push(tokens.join(' '));

    const words = tokens.filter(x => !/^\d+$/.test(x) && !GENERIC_MEDIA_TITLE_TOKENS.has(x));
    const last = words[words.length - 1];
    if (last) {
      // Single-word searches for long titles are too broad (for example "live"
      // or "home"). Keep them only for genuinely one-word titles or sequels,
      // where the number makes the query sufficiently specific.
      if (sequel) distinctive.push(`${last} ${sequel}`);
      else if (words.length === 1) distinctive.push(last);

      // Stemmed searches are retained only for sequels such as Prada/Pradu 2.
      if (sequel && last.length >= 5) stems.push(`${last.slice(0, 4)} ${sequel}`);
    }
  }

  // Full localized names are intentionally placed first so MAX_SEARCH_TERMS
  // cannot discard them in favour of stemmed variants of the English title.
  const arr = [...full, ...withYear, ...normalizedTitles, ...distinctive, ...stems];
  if (meta.imdbId) arr.push(meta.imdbId);
  return uniqueSearchTerms(arr).slice(0, MAX_SEARCH_TERMS);
}
function termsFor(meta) {
  if (meta.type === 'series' && meta.season && meta.episode) {
    const s = Number(meta.season);
    const e = Number(meta.episode);
    const sp = String(s).padStart(2, '0');
    const ep = String(e).padStart(2, '0');
    const titles = getTitleAliases(meta);
    const exact = [], alternateEpisode = [], shortened = [], titleOnly = [];

    for (const title of titles) {
      const asciiTitle = normalize(title);
      const fullVariants = uniqueSearchTerms([title, asciiTitle]);
      const tokens = significantTitleTokens(title).filter(x => !/^\d+$/.test(x));
      const shortVariants = uniqueSearchTerms([
        tokens.length >= 2 ? tokens.join(' ') : '',
        tokens.length ? tokens[tokens.length - 1] : ''
      ]);

      for (const variant of fullVariants) {
        exact.push(`${variant} S${sp}E${ep}`);
        alternateEpisode.push(`${variant} ${s}x${ep}`, `${variant} season ${s} episode ${e}`);
        titleOnly.push(variant);
      }
      for (const variant of shortVariants) {
        shortened.push(`${variant} S${sp}E${ep}`, `${variant} ${s}x${ep}`);
      }
    }

    const arr = [...exact, ...alternateEpisode, ...shortened, ...titleOnly];
    if (meta.imdbId) arr.push(`${meta.imdbId} S${sp}E${ep}`);
    return uniqueSearchTerms(arr).slice(0, MAX_SEARCH_TERMS);
  }

  return movieTermsFor(meta);
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
function mapFile(raw) {
  const name = raw.filename || raw.name || '';
  return { id: raw.id, name, size: raw.data?.value || raw.size || 0, url: raw.download_url || raw.url, image: raw.thumbnail, duration: raw.duration?.value || raw.duration || '', durationText: raw.duration_f || '', resolution: raw.resolution, raw };
}
async function searchFastshare(term, hash) {
  const url = `${API}?process=search&pagination=200&term=${esc(term)}&adult=0`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Kodi/20 FastShare Stremio', 'Cookie': `FASTSHARE=${hash}` } });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = null; }
  const list = json?.search?.file || json?.file || json?.files || [];
  return { term, status: res.status, resultCount: Array.isArray(list) ? list.length : 0, apiUrl: url, files: Array.isArray(list) ? list.map(mapFile) : [], rawPreview: txt.slice(0, 500) };
}
function streamUrl(file, hash) {
  const base = file.url || file.raw?.download_url;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}stream=1&session=${esc(hash)}&${esc(file.name)}`;
}
function detectBadgeTags(name, file = {}) {
  const raw = String(name || '');
  const n = normalize(raw);
  const tags = [];
  const add = tag => { if (tag && !tags.includes(tag)) tags.push(tag); };

  // Source / release type. Keep the same spelling used by common Nuvio badge presets.
  if (/\bremux\b/i.test(raw)) add('REMUX');
  else if (/\b(?:blu[ ._-]?ray|bdremux|bdrip|brrip)\b/i.test(raw)) add('BluRay');
  else if (/\b(?:web[ ._-]?dl|webdl|web[ ._-]?rip|webrip)\b/i.test(raw)) add('WEB-DL');
  else if (/\bhdtv\b/i.test(raw)) add('HDTV');

  const quality = file.quality || detectQuality(raw);
  if (quality === '4K') add('2160p');
  else if (quality === '1080p') add('1080p');
  else if (quality === '720p') add('720p');
  else if (quality === '480p') add('480p');

  // Visual tags. Specific formats go before generic HDR/IMAX tags.
  if (/\bimax[ ._-]?enhanced\b/i.test(raw)) add('IMAX Enhanced');
  else if (/\bimax\b/i.test(raw)) add('IMAX');
  if (/\b(?:dovi|dolby[ ._-]?vision|dv)\b/i.test(raw)) add('DV');
  if (/\bhdr[ ._-]?10[ ._-]?(?:\+|plus|p)\b/i.test(raw)) add('HDR10+');
  else if (/\bhdr[ ._-]?10\b/i.test(raw)) add('HDR10');
  else if (/\bhdr\b/i.test(raw)) add('HDR');

  // Video codec aliases are normalized so badge regexes do not depend on filename style.
  if (/\b(?:av1|av01)\b/i.test(raw)) add('AV1');
  else if (/\b(?:hevc|h[ ._-]?265|x265)\b/i.test(raw)) add('HEVC');
  else if (/\b(?:avc|h[ ._-]?264|x264)\b/i.test(raw)) add('AVC');

  // Audio formats. Multiple tags are intentional: presets decide which combinations to show.
  if (/\batmos\b/i.test(raw)) add('Atmos');
  if (/\btrue[ ._-]?hd\b/i.test(raw)) add('TrueHD');
  if (/\bdts[ ._:-]?x\b/i.test(raw)) add('DTS:X');
  else if (/\bdts[ ._-]?(?:hd[ ._-]?)?ma\b/i.test(raw)) add('DTS-HD MA');
  else if (/\bdts[ ._-]?hd\b/i.test(raw)) add('DTS-HD');
  else if (/\bdts\b/i.test(raw)) add('DTS');
  if (/\b(?:ddp(?:[ ._-]?[257][ .][01])?|dd\+|e[ ._-]?ac[ ._-]?3|eac3)\b/i.test(raw)) add('DD+');
  else if (/\b(?:ac[ ._-]?3|dd(?:2[ .]0|5[ .]1|7[ .]1)?)\b/i.test(raw)) add('DD');
  if (/\b(?:aac|aac2[ .]0|aac5[ .]1)\b/i.test(raw)) add('AAC');

  // Channel layout. Use the dotted form expected by common presets.
  const channel = raw.match(/(?:^|[^0-9])([2-8])[ .]([01])(?:[^0-9]|$)/);
  if (channel) add(`${channel[1]}.${channel[2]}`);

  // Language tokens are based on the already validated audio detector, not loose filename text.
  const audio = file.audio || detectAudio(raw);
  const key = String(audio.key || '');
  if (key.includes('CZ')) add('CZ');
  if (key.includes('SK')) add('SK');
  if (key.includes('EN')) add('EN');
  if (key === 'multi') add('MULTI');
  if ((audio.subs || []).some(x => /^CZ /i.test(x))) add('CZ SUBS');
  if ((audio.subs || []).some(x => /^SK /i.test(x))) add('SK SUBS');

  return tags;
}
function streamObj(file, hash, recommended) {
  const size = bytesToHuman(file.size);
  const bits = [file.quality, size, file.ext, file.durationText].filter(Boolean).join(' • ');
  const lang = [file.audio.label, ...(file.audio.subs || [])].filter(Boolean).join(' • ');
  const badgeTags = detectBadgeTags(file.name, file);

  // Nuvio badge presets match regular expressions against stream.title. Many patterns
  // are anchored with ^ and use a look-ahead that does not cross a newline, so all
  // normalized badge tokens must be present on the first line. Previously the first
  // result started with only "⭐ Odporúčané", hiding its badges.
  const firstLine = [recommended ? '⭐ Odporúčané' : '', ...badgeTags].filter(Boolean).join(' • ') || 'FastShare';
  const title = `${firstLine}\n${file.name}\n${bits}\n${lang}`;
  return {
    name: `FastShare${file.audio.key !== 'any' ? ' ' + file.audio.key.replace('-', '/') : ''}`,
    title,
    url: streamUrl(file, hash),
    behaviorHints: {
      bingeGroup: `fastshare-${file.quality || 'auto'}-${file.audio.key}`,
      filename: file.name,
      videoSize: Number(file.size || 0) || undefined
    }
  };
}
async function buildStreamResponse(req, debug = false) {
  const creds = getCredentials(req);
  const auth = await login(creds);
  const type = req.params.type, id = req.params.id;
  const meta = await getMeta(type, id);
  if (!auth.ok) return debug ? { ok: true, version: VERSION, auth, streams: [] } : { streams: [] };
  const terms = termsFor(meta);
  const searchResults = await mapWithConcurrency(terms, SEARCH_CONCURRENCY, term => searchFastshare(term, auth.hash));
  const searches = searchResults.map(r => ({ term: r.term, status: r.status, resultCount: r.resultCount, apiUrl: r.apiUrl, firstFiles: r.files.slice(0,3) }));
  const all = searchResults.flatMap(r => r.files);
  const scored = all.map(f => scoreFile(f, meta, type)).filter(Boolean).filter(f => f.score > (type === 'series' ? 20 : 50));
  const sorted = dedupe(scored).sort((a,b) => b.score - a.score).slice(0, MAX_STREAMS);
  const streams = sorted.map((f, i) => streamObj(f, auth.hash, i === 0));
  if (!debug) return { streams };
  return { ok: true, version: VERSION, request: { type, id }, meta, terms, auth: { ok: true, source: auth.source, hasHash: true }, search: searches, streamCount: streams.length, files: sorted, streams };
}

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));
app.get('/manifest.json', (req, res) => res.json(manifest(null)));
app.get('/:config/manifest.json', (req, res) => res.json(manifest(req.params.config)));

app.get('/configure', (req, res) => {
  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FastShare Stremio Configurator</title>
<style>
body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
input,button{font-size:16px;padding:12px;border-radius:8px;border:1px solid #444;background:#222;color:#fff;width:100%;box-sizing:border-box;margin:8px 0}
button{background:#1976d2;cursor:pointer}.box{background:#1b1b1b;padding:18px;border-radius:12px;margin:12px 0}
code,textarea{word-break:break-all;color:#9cdcfe;background:#0b0b0b}.warn{color:#ffd166}.ok{color:#8ee59b}
a{color:#8ab4ff} textarea{width:100%;min-height:92px;border:1px solid #444;border-radius:8px;padding:10px;box-sizing:border-box}
</style></head>
<body>
<h1>FastShare Stremio Addon</h1>
<div class="box">
<p>Zadaj FastShare prihlasenie. Údaje sa uložia iba do vygenerovanej manifest URL.</p>
<input id="fsUser" name="username" placeholder="FastShare username" autocomplete="username">
<input id="fsPass" name="password" placeholder="FastShare password" type="password" autocomplete="current-password">
<button type="button" id="genBtn">Vygenerovať URL</button>
<p class="warn">URL neposielaj verejne, obsahuje zakódované prihlasovanie.</p>
<div id="out"><p>Zatiaľ nie je vygenerovaná žiadna URL.</p></div>
</div>
<div class="box">
<p><b>Fallback bez JavaScriptu:</b> keď tlačidlo nefunguje, použi toto tlačidlo. Presmeruje ťa priamo na konfigurovaný manifest.</p>
<form method="post" action="/configure">
<input name="username" placeholder="FastShare username">
<input name="password" placeholder="FastShare password" type="password">
<button type="submit">Otvoriť manifest bez JS</button>
</form>
</div>
<script>
(function(){
  var BASE = ${JSON.stringify(origin)};
  function encUtf8ToB64Url(str){
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function html(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function generate(){
    var u = document.getElementById('fsUser').value.trim();
    var p = document.getElementById('fsPass').value;
    var out = document.getElementById('out');
    if(!u || !p){ out.innerHTML = '<p class="warn">Vyplň username aj password.</p>'; return; }
    var token = encUtf8ToB64Url(JSON.stringify({username:u,password:p}));
    var manifestUrl = BASE + '/' + token + '/manifest.json';
    var stremioUrl = 'stremio://' + manifestUrl.replace(/^https?:\/\//,'');
    out.innerHTML = '<p class="ok"><b>URL vygenerovaná.</b></p>'+
      '<p><b>Manifest URL:</b></p><textarea readonly onclick="this.select()">'+html(manifestUrl)+'</textarea>'+
      '<p><a href="'+html(stremioUrl)+'">Install do Stremia</a></p>'+
      '<p><a href="'+html(manifestUrl)+'" target="_blank">Otvoriť manifest v prehliadači</a></p>';
  }
  document.getElementById('genBtn').addEventListener('click', generate);
})();
</script>
</body></html>`);
});

app.post('/configure', (req, res) => {
  const token = b64urlEncode({ username: req.body.username || '', password: req.body.password || '' });
  res.redirect(`/${token}/manifest.json`);
});

app.get('/debug/login', async (req, res) => res.json({ ok: true, version: VERSION, login: await login(getCredentials(req)) }));
app.get('/:config/debug/login', async (req, res) => res.json({ ok: true, version: VERSION, login: await login(getCredentials(req)) }));
app.get('/debug/search', async (req, res) => { const auth = await login(getCredentials(req)); if (!auth.ok) return res.json({ ok: true, version: VERSION, auth, resultCount: 0, files: [] }); const r = await searchFastshare(req.query.term || 'avatar', auth.hash); res.json({ ok: true, version: VERSION, auth: { ok: true, hasHash: true }, ...r }); });
app.get('/:config/debug/search', async (req, res) => { const auth = await login(getCredentials(req)); if (!auth.ok) return res.json({ ok: true, version: VERSION, auth, resultCount: 0, files: [] }); const r = await searchFastshare(req.query.term || 'avatar', auth.hash); res.json({ ok: true, version: VERSION, auth: { ok: true, hasHash: true }, ...r }); });
app.get('/debug/meta/:type/:id.json', async (req, res) => { try { const meta = await getMeta(req.params.type, req.params.id); res.json({ ok: true, version: VERSION, meta, aliases: getTitleAliases(meta), terms: termsFor(meta) }); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });
app.get('/:config/debug/meta/:type/:id.json', async (req, res) => { try { const meta = await getMeta(req.params.type, req.params.id); res.json({ ok: true, version: VERSION, meta, aliases: getTitleAliases(meta), terms: termsFor(meta) }); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });

app.get('/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/:config/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/debug/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, true)); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });
app.get('/:config/debug/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, true)); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });

if (require.main === module) {
  app.listen(PORT, () => console.log(`FastShare Stremio addon v${VERSION} on ${PORT}`));
}

module.exports = {
  app,
  normalize,
  detectAudio,
  getTitleAliases,
  extractTmdbLocalizedAliases,
  extractWikidataLocalizedAliases,
  getLocalizedTitleData,
  extractSequelNumber,
  aliasMatchScore,
  titleMatchScore,
  scoreFile,
  termsFor,
  detectBadgeTags,
  streamObj
};
