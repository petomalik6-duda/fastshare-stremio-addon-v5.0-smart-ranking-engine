'use strict';

const {
  VERSION,
  SEARCH_CONCURRENCY,
  TMDB_API_KEY,
  TMDB_READ_ACCESS_TOKEN
} = require('./config');
const { fetchJson, mapWithConcurrency, getFreshCache, setCache, normalize } = require('./utils');
const { searchTermPlan, rankFiles, detectAudio, getTitleAliases } = require('./ranking');
const { getMeta } = require('./metadata');
const { login: fastshareLogin, searchFastshare } = require('./fastshare');
const { login: webshareLogin, searchWebshare } = require('./webshare');

const CATALOG_CACHE_TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS || 1000 * 60 * 15);
const CATALOG_CACHE_MAX = 120;
const CATALOG_PAGE_SIZE = Math.max(10, Math.min(40, Number(process.env.CATALOG_PAGE_SIZE || 20)));
const CANDIDATE_LIMIT = Math.max(CATALOG_PAGE_SIZE, Math.min(60, Number(process.env.CATALOG_CANDIDATE_LIMIT || 50)));
const LOCAL_CANDIDATE_LIMIT = Math.max(30, Math.min(80, Number(process.env.LOCAL_CANDIDATE_LIMIT || 50)));
const catalogCache = new Map();

const FALSE_DUB_SERIES = new Set([
  'tt10986410'
]);

const CATALOGS = [
  { id: 'unified-latest-movies', type: 'movie', name: '🆕 Najnovšie dostupné filmy', source: 'latest', requireDub: false },
  { id: 'unified-latest-series', type: 'series', name: '🆕 Najnovšie dostupné seriály', source: 'latest', requireDub: false },
  { id: 'unified-concerts', type: 'movie', name: '🎵 Koncerty', source: 'concerts', requireDub: false },
  { id: 'unified-czsk-movies', type: 'movie', name: '🇨🇿🇸🇰 CZ/SK dabing + originál – filmy' },
  { id: 'unified-czsk-series', type: 'series', name: '🇨🇿🇸🇰 CZ/SK dabing + originál – seriály' },
  { id: 'unified-cz-movies', type: 'movie', name: '🇨🇿 CZ dabing + české filmy', audio: 'cz' },
  { id: 'unified-sk-movies', type: 'movie', name: '🇸🇰 SK dabing + slovenské filmy', audio: 'sk' },
  { id: 'unified-4k-czsk', type: 'movie', name: '🎬 4K CZ/SK dabing + originál', quality: '2160p' }
];

function catalogDef(id, type) {
  return CATALOGS.find(item => item.id === id && item.type === type) || null;
}

function preferredLocalizedTitle(meta, fallback = '') {
  const details = Array.isArray(meta?.localizedTitleData?.aliasDetails)
    ? meta.localizedTitleData.aliasDetails
    : [];
  const pick = lang => details.find(item => String(item?.language || '').toLowerCase() === lang && String(item?.title || '').trim());
  return pick('cs')?.title || pick('sk')?.title || meta?.title || fallback || '';
}

function strictDubLanguage(file) {
  const audio = file?.audio || detectAudio(file?.name || '');
  if (!audio?.verifiedAudio || audio?.evidence !== 'explicit-dub') return { cz: false, sk: false };
  const key = String(audio?.key || '').toUpperCase();
  return {
    cz: key === 'CZ' || key === 'CZ-SK',
    sk: key === 'SK' || key === 'CZ-SK'
  };
}

function hasCzSkAudio(file, requested = null) {
  const lang = strictDubLanguage(file);
  if (requested === 'cz') return lang.cz;
  if (requested === 'sk') return lang.sk;
  return lang.cz || lang.sk;
}

function qualityMatches(file, wanted) {
  if (!wanted) return true;
  return String(file?.quality || '').toLowerCase() === wanted.toLowerCase() || /(?:^|\D)(2160p|4k|uhd)(?:\D|$)/i.test(file?.name || '');
}

function tmdbHeaders() {
  if (TMDB_READ_ACCESS_TOKEN) {
    return {
      Authorization: `Bearer ${TMDB_READ_ACCESS_TOKEN}`,
      Accept: 'application/json',
      'User-Agent': `FastShare-Webshare/${VERSION}`
    };
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

function tmdbEnabled() {
  return Boolean(TMDB_API_KEY || TMDB_READ_ACCESS_TOKEN);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function tmdbExternalId(type, tmdbId) {
  const path = type === 'series' ? `/tv/${tmdbId}/external_ids` : `/movie/${tmdbId}/external_ids`;
  const data = await fetchJson(tmdbUrl(path), { headers: tmdbHeaders() });
  return String(data?.imdb_id || '');
}

async function fetchTmdbDiscoverPages(type, mode, startPage, pageCount) {
  if (!tmdbEnabled()) return [];
  const today = new Date();
  const past = new Date(today.getTime() - 1000 * 60 * 60 * 24 * 730);
  const isSeries = type === 'series';
  const path = isSeries ? '/discover/tv' : '/discover/movie';
  const pages = Array.from({ length: pageCount }, (_, i) => startPage + i);

  const payloads = await mapWithConcurrency(pages, 3, page => {
    const params = {
      language: 'cs-CZ',
      page,
      include_adult: 'false',
      sort_by: isSeries ? 'first_air_date.desc' : 'primary_release_date.desc'
    };
    if (isSeries) {
      params['first_air_date.gte'] = isoDate(past);
      params['first_air_date.lte'] = isoDate(today);
    } else {
      params['primary_release_date.gte'] = isoDate(past);
      params['primary_release_date.lte'] = isoDate(today);
    }
    if (mode === 'concerts') {
      params.with_genres = '10402';
      params.sort_by = 'popularity.desc';
    }
    return fetchJson(tmdbUrl(path, params), { headers: tmdbHeaders() });
  });

  return payloads.flatMap(data => Array.isArray(data?.results) ? data.results : []);
}

async function mapTmdbItems(type, items, limit = CANDIDATE_LIMIT) {
  const unique = [];
  const seen = new Set();
  for (const item of items || []) {
    const uniqueKey = `${item?.id || ''}:${item?._nativeLocale || ''}`;
    if (!item?.id || seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    unique.push(item);
    if (unique.length >= limit) break;
  }

  const mapped = await mapWithConcurrency(unique, 8, async item => {
    try {
      const imdbId = await tmdbExternalId(type, item.id);
      if (!/^tt\d+$/.test(imdbId)) return null;
      const name = item.title || item.name || item.original_title || item.original_name || imdbId;
      const releaseDate = item.release_date || item.first_air_date || '';
      return {
        id: imdbId,
        type,
        name,
        poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
        background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : undefined,
        description: item.overview || '',
        releaseInfo: releaseDate ? releaseDate.slice(0, 4) : '',
        year: releaseDate ? Number(releaseDate.slice(0, 4)) : undefined,
        genres: [],
        _releaseDate: releaseDate,
        _nativeLocale: item._nativeLocale || undefined,
        _tmdbId: item.id
      };
    } catch {
      return null;
    }
  });

  return mapped.filter(Boolean);
}

async function tmdbCandidates(type, skip = 0, mode = 'latest') {
  if (!tmdbEnabled()) return [];
  const startPage = Math.floor(Math.max(0, Number(skip || 0)) / 20) + 1;
  const pageCount = mode === 'concerts' ? 8 : 4;
  let rows = await fetchTmdbDiscoverPages(type, mode, startPage, pageCount);

  if (mode === 'concerts') {
    const concertTitleRx = /\b(concert|live\s+(at|in|from)|live$|world\s+tour|tour\s+live|unplugged|festival|live\s+concert|live\s+performance)\b/i;
    rows = rows.filter(item => concertTitleRx.test(String(item.title || item.name || item.original_title || item.original_name || '')));
  }

  const mapped = await mapTmdbItems(type, rows, CANDIDATE_LIMIT);
  return mapped.sort((a, b) => String(b._releaseDate || '').localeCompare(String(a._releaseDate || '')));
}

async function tmdbLocalCandidates(type, skip = 0) {
  if (!tmdbEnabled()) return [];
  const isSeries = type === 'series';
  const path = isSeries ? '/discover/tv' : '/discover/movie';
  const startPage = Math.floor(Math.max(0, Number(skip || 0)) / 20) + 1;
  const pages = [startPage, startPage + 1];
  const locales = [
    { language: 'cs', country: 'CZ', nativeLocale: 'cz' },
    { language: 'sk', country: 'SK', nativeLocale: 'sk' }
  ];
  const requests = [];
  for (const locale of locales) {
    for (const page of pages) requests.push({ ...locale, page });
  }

  const payloads = await mapWithConcurrency(requests, 4, req => {
    const params = {
      language: req.nativeLocale === 'cz' ? 'cs-CZ' : 'sk-SK',
      page: req.page,
      include_adult: 'false',
      sort_by: isSeries ? 'first_air_date.desc' : 'primary_release_date.desc',
      with_original_language: req.language,
      with_origin_country: req.country
    };
    return fetchJson(tmdbUrl(path, params), { headers: tmdbHeaders() })
      .then(data => (Array.isArray(data?.results) ? data.results : []).map(item => ({ ...item, _nativeLocale: req.nativeLocale })));
  });

  const rows = payloads.flat();
  const mapped = await mapTmdbItems(type, rows, LOCAL_CANDIDATE_LIMIT);
  return mapped.sort((a, b) => String(b._releaseDate || '').localeCompare(String(a._releaseDate || '')));
}

async function cinemetaCandidates(type, skip = 0, pages = 1) {
  const offsets = Array.from({ length: pages }, (_, i) => Math.max(0, Number(skip || 0)) + i * 100);
  const payloads = await mapWithConcurrency(offsets, 2, offset => fetchJson(
    `https://v3-cinemeta.strem.io/catalog/${type}/top.json?skip=${offset}`,
    { headers: { 'User-Agent': `FastShare-Webshare/${VERSION}` } }
  ));
  return payloads.flatMap(payload => Array.isArray(payload?.metas) ? payload.metas : []).slice(0, CANDIDATE_LIMIT);
}

function mergeCandidates(local, global, limit = 80) {
  const out = [];
  const seen = new Set();
  const push = item => {
    const id = String(item?.id || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(item);
  };
  const max = Math.max(local?.length || 0, global?.length || 0);
  for (let i = 0; i < max && out.length < limit; i++) {
    if (local?.[i]) push(local[i]);
    if (global?.[i]) push(global[i]);
  }
  return out;
}

async function catalogCandidates(type, def, skip) {
  if (def.source === 'latest') {
    const tmdb = await tmdbCandidates(type, skip, 'latest');
    if (tmdb.length) return tmdb;
    const fallback = await cinemetaCandidates(type, skip, 2);
    return fallback.sort((a, b) => String(b.releaseInfo || b.year || '').localeCompare(String(a.releaseInfo || a.year || '')));
  }
  if (def.source === 'concerts') {
    const tmdb = await tmdbCandidates('movie', skip, 'concerts');
    if (tmdb.length) return tmdb;
    const fallback = await cinemetaCandidates('movie', skip, 4);
    const titleRx = /\b(concert|live\s+(at|in|from)|world\s+tour|tour\s+live|unplugged|festival)\b/i;
    return fallback.filter(item => titleRx.test(String(item.name || ''))).slice(0, CANDIDATE_LIMIT);
  }

  const [local, global] = await Promise.all([
    tmdbLocalCandidates(type, skip),
    cinemetaCandidates(type, skip, 1)
  ]);
  return mergeCandidates(local, global, Math.max(80, CANDIDATE_LIMIT));
}

function providerCreds(config) {
  return { fastshare: config?.fastshare || {}, webshare: config?.webshare || {} };
}

async function authProviders(config) {
  const creds = providerCreds(config);
  const [fastshare, webshare] = await Promise.all([
    creds.fastshare?.username && creds.fastshare?.password ? fastshareLogin(creds.fastshare) : Promise.resolve({ ok: false, error: 'not configured' }),
    creds.webshare?.username && creds.webshare?.password ? webshareLogin(creds.webshare) : Promise.resolve({ ok: false, error: 'not configured' })
  ]);
  return { fastshare, webshare };
}

async function searchOneProvider(terms, provider, auth, maxTerms = 1) {
  if (!auth?.ok || !terms.length) return [];
  const selected = terms.slice(0, Math.max(1, maxTerms));
  const responses = await mapWithConcurrency(selected, Math.min(SEARCH_CONCURRENCY, 2), term => {
    if (provider === 'fastshare') return searchFastshare(term, auth.hash);
    return searchWebshare(term, auth.token);
  });
  return responses.flatMap(result => Array.isArray(result?.files) ? result.files : []);
}

function strictSeriesTitleEvidence(file, meta) {
  const raw = String(file?.name || '');
  const name = normalize(raw);
  if (!name) return false;
  const aliases = getTitleAliases(meta);
  const titleOk = aliases.some(alias => {
    const n = normalize(alias);
    if (!n) return false;
    if (name.includes(n)) return true;
    const tokens = n.split(' ').filter(token => token.length >= 3 && !['the', 'and', 'for', 'with', 'live'].includes(token));
    return tokens.length >= 2 && tokens.every(token => name.split(' ').includes(token));
  });
  if (!titleOk) return false;
  return /\bS\d{1,2}(?:E\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b|\bseason\s*\d{1,2}\b|\bseria\s*\d{1,2}\b/i.test(raw);
}

function nativeLocaleAllowed(base, def) {
  const locale = String(base?._nativeLocale || '').toLowerCase();
  if (!['cz', 'sk'].includes(locale)) return false;
  if (def.audio === 'cz') return locale === 'cz';
  if (def.audio === 'sk') return locale === 'sk';
  return true;
}

async function availabilityForMeta(meta, type, def, auth, base = null) {
  const imdbId = String(meta?.imdbId || meta?.id || '').split(':')[0];
  if (type === 'series' && def.requireDub !== false && FALSE_DUB_SERIES.has(imdbId)) return null;

  const plan = searchTermPlan(meta);
  const terms = plan.primary.length ? plan.primary : plan.fallback;
  const maxTerms = def.source ? 1 : 2;
  const [fastFiles, webFiles] = await Promise.all([
    searchOneProvider(terms, 'fastshare', auth.fastshare, maxTerms),
    searchOneProvider(terms, 'webshare', auth.webshare, maxTerms)
  ]);

  const files = [
    ...fastFiles.map(file => ({ ...file, provider: 'fastshare' })),
    ...webFiles.map(file => ({ ...file, provider: 'webshare' }))
  ];

  let ranked = rankFiles(files, meta, type)
    .filter(file => qualityMatches(file, def.quality || null));

  if (def.requireDub !== false) {
    const nativeLocal = nativeLocaleAllowed(base, def);
    if (!nativeLocal) ranked = ranked.filter(file => hasCzSkAudio(file, def.audio || null));
    if (type === 'series') {
      ranked = ranked.filter(file => strictSeriesTitleEvidence(file, meta));
      const uniqueNames = new Set(ranked.map(file => normalize(file.name || '')));
      if (uniqueNames.size < 2) return null;
    }
  }

  return ranked[0] || null;
}

function metaToCatalogItem(base, match, type, def, meta) {
  const behaviorHints = { ...(base.behaviorHints || {}) };
  if (type === 'movie') behaviorHints.defaultVideoId = base.id;
  else delete behaviorHints.defaultVideoId;

  const item = {
    id: base.id,
    type,
    name: preferredLocalizedTitle(meta, base.name),
    poster: base.poster,
    background: base.background,
    logo: base.logo,
    description: base.description,
    releaseInfo: base.releaseInfo,
    year: base.year,
    imdbRating: base.imdbRating,
    genres: base.genres,
    director: base.director,
    cast: base.cast,
    runtime: base.runtime,
    trailers: base.trailers,
    links: base.links,
    behaviorHints
  };

  let prefix;
  if (base?._nativeLocale === 'cz') {
    prefix = `Český originál dostupný cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`;
  } else if (base?._nativeLocale === 'sk') {
    prefix = `Slovenský originál dostupný cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`;
  } else if (def.source === 'concerts') {
    prefix = `Koncert dostupný cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`;
  } else if (def.source === 'latest') {
    prefix = `Dostupné cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`;
  } else {
    prefix = `Explicitný CZ/SK dub marker nájdený cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`;
  }

  item.description = [prefix, base.description || ''].filter(Boolean).join(' ');
  return item;
}

async function buildCatalog({ type, id, skip = 0, config, configKey = '' }) {
  const def = catalogDef(id, type);
  if (!def) return { metas: [] };
  const normalizedSkip = Math.max(0, Number(skip || 0));
  const cacheKey = `catalog-v10:${configKey}:${type}:${id}:${normalizedSkip}`;
  const cached = getFreshCache(catalogCache, cacheKey, CATALOG_CACHE_TTL_MS);
  if (cached) return { ...cached, cache: 'hit' };

  const auth = await authProviders(config);
  if (!auth.fastshare.ok && !auth.webshare.ok) return { metas: [], auth: { fastshare: false, webshare: false } };

  const candidates = await catalogCandidates(type, def, normalizedSkip);
  const checked = await mapWithConcurrency(candidates, 4, async base => {
    try {
      const meta = await getMeta(type, base.id);
      const match = await availabilityForMeta(meta, type, def, auth, base);
      return match ? metaToCatalogItem(base, match, type, def, meta) : null;
    } catch {
      return null;
    }
  });

  const metas = checked.filter(Boolean).slice(0, CATALOG_PAGE_SIZE);
  const value = {
    metas,
    auth: { fastshare: auth.fastshare.ok, webshare: auth.webshare.ok },
    generatedAt: new Date().toISOString(),
    source: def.source || 'cinemeta+tmdb-local',
    tmdbEnabled: tmdbEnabled(),
    candidates: candidates.length,
    localCandidates: candidates.filter(item => item?._nativeLocale).length,
    cache: 'miss'
  };
  setCache(catalogCache, cacheKey, value, CATALOG_CACHE_TTL_MS, CATALOG_CACHE_MAX);
  return value;
}

module.exports = {
  CATALOGS,
  catalogDef,
  buildCatalog,
  hasCzSkAudio,
  qualityMatches,
  strictDubLanguage,
  strictSeriesTitleEvidence,
  preferredLocalizedTitle,
  nativeLocaleAllowed,
  tmdbCandidates,
  tmdbLocalCandidates,
  catalogCandidates
};
