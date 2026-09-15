'use strict';

const {
  VERSION,
  SEARCH_CONCURRENCY,
  TMDB_API_KEY,
  TMDB_READ_ACCESS_TOKEN
} = require('./config');
const { fetchJson, mapWithConcurrency, getFreshCache, setCache } = require('./utils');
const { searchTermPlan, rankFiles, detectAudio } = require('./ranking');
const { getMeta } = require('./metadata');
const { login: fastshareLogin, searchFastshare } = require('./fastshare');
const { login: webshareLogin, searchWebshare } = require('./webshare');

const CATALOG_CACHE_TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS || 1000 * 60 * 20);
const CATALOG_CACHE_MAX = 100;
const CATALOG_PAGE_SIZE = Math.max(10, Math.min(40, Number(process.env.CATALOG_PAGE_SIZE || 20)));
const CANDIDATE_LIMIT = Math.max(CATALOG_PAGE_SIZE, Math.min(80, Number(process.env.CATALOG_CANDIDATE_LIMIT || 40)));
const catalogCache = new Map();

const CATALOGS = [
  { id: 'unified-latest-movies', type: 'movie', name: '🆕 Posledné pridané filmy', source: 'latest' },
  { id: 'unified-latest-series', type: 'series', name: '🆕 Posledné pridané seriály', source: 'latest' },
  { id: 'unified-concerts', type: 'movie', name: '🎵 Koncerty', source: 'concerts', requireDub: false },
  { id: 'unified-czsk-movies', type: 'movie', name: '🇨🇿🇸🇰 CZ/SK dabing – filmy' },
  { id: 'unified-czsk-series', type: 'series', name: '🇨🇿🇸🇰 CZ/SK dabing – seriály' },
  { id: 'unified-cz-movies', type: 'movie', name: '🇨🇿 CZ dabing – filmy', audio: 'cz' },
  { id: 'unified-sk-movies', type: 'movie', name: '🇸🇰 SK dabing – filmy', audio: 'sk' },
  { id: 'unified-4k-czsk', type: 'movie', name: '🎬 4K CZ/SK dabing', quality: '2160p' }
];

function catalogDef(id, type) {
  return CATALOGS.find(item => item.id === id && item.type === type) || null;
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

async function tmdbCandidates(type, skip = 0, mode = 'latest') {
  if (!tmdbEnabled()) return [];
  const page = Math.floor(Math.max(0, Number(skip || 0)) / 20) + 1;
  const today = new Date();
  const past = new Date(today.getTime() - (1000 * 60 * 60 * 24 * 548));
  const isSeries = type === 'series';
  const path = isSeries ? '/discover/tv' : '/discover/movie';
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
  if (mode === 'concerts') params.with_genres = '10402';

  const data = await fetchJson(tmdbUrl(path, params), { headers: tmdbHeaders() });
  let rows = Array.isArray(data?.results) ? data.results : [];

  if (mode === 'concerts') {
    const concertRx = /\b(concert|live|tour|performance|show|festival|arena|stadium|unplugged|world tour)\b/i;
    rows = rows.filter(item => concertRx.test(`${item.title || item.name || ''} ${item.overview || ''}`));
  }

  const mapped = await mapWithConcurrency(rows.slice(0, CANDIDATE_LIMIT), 5, async item => {
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
        _releaseDate: releaseDate
      };
    } catch {
      return null;
    }
  });

  return mapped.filter(Boolean).sort((a, b) => String(b._releaseDate || '').localeCompare(String(a._releaseDate || '')));
}

async function cinemetaCandidates(type, skip = 0) {
  const url = `https://v3-cinemeta.strem.io/catalog/${type}/top.json?skip=${Math.max(0, Number(skip || 0))}`;
  const payload = await fetchJson(url, { headers: { 'User-Agent': `FastShare-Webshare/${VERSION}` } });
  return (Array.isArray(payload?.metas) ? payload.metas : []).slice(0, CANDIDATE_LIMIT);
}

async function catalogCandidates(type, def, skip) {
  if (def.source === 'latest') {
    const tmdb = await tmdbCandidates(type, skip, 'latest');
    if (tmdb.length) return tmdb;
    const fallback = await cinemetaCandidates(type, skip);
    return fallback.sort((a, b) => String(b.releaseInfo || b.year || '').localeCompare(String(a.releaseInfo || a.year || '')));
  }
  if (def.source === 'concerts') {
    const tmdb = await tmdbCandidates('movie', skip, 'concerts');
    if (tmdb.length) return tmdb;
    const fallback = await cinemetaCandidates('movie', skip);
    const rx = /\b(concert|live|tour|performance|festival|arena|stadium|unplugged)\b/i;
    return fallback.filter(item => rx.test(`${item.name || ''} ${item.description || ''}`));
  }
  return cinemetaCandidates(type, skip);
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

async function searchOneProvider(terms, provider, auth) {
  if (!auth?.ok || !terms.length) return [];
  const firstTerms = terms.slice(0, 3);
  const responses = await mapWithConcurrency(firstTerms, Math.min(SEARCH_CONCURRENCY, 2), term => {
    if (provider === 'fastshare') return searchFastshare(term, auth.hash);
    return searchWebshare(term, auth.token);
  });
  return responses.flatMap(result => Array.isArray(result?.files) ? result.files : []);
}

async function availabilityForMeta(meta, type, def, auth) {
  const plan = searchTermPlan(meta);
  const terms = plan.primary.length ? plan.primary : plan.fallback.slice(0, 3);
  const [fastFiles, webFiles] = await Promise.all([
    searchOneProvider(terms, 'fastshare', auth.fastshare),
    searchOneProvider(terms, 'webshare', auth.webshare)
  ]);

  const files = [
    ...fastFiles.map(file => ({ ...file, provider: 'fastshare' })),
    ...webFiles.map(file => ({ ...file, provider: 'webshare' }))
  ];

  let ranked = rankFiles(files, meta, type)
    .filter(file => qualityMatches(file, def.quality || null));

  if (def.requireDub !== false) {
    ranked = ranked.filter(file => hasCzSkAudio(file, def.audio || null));
  }

  return ranked[0] || null;
}

function metaToCatalogItem(base, match, type, def) {
  const behaviorHints = { ...(base.behaviorHints || {}) };
  if (type === 'movie') behaviorHints.defaultVideoId = base.id;
  else delete behaviorHints.defaultVideoId;

  const item = {
    id: base.id,
    type,
    name: base.name,
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

  const prefix = def.source === 'concerts'
    ? `Dostupný koncert cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`
    : def.requireDub === false
      ? `Dostupné cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`
      : `Overený explicitný CZ/SK dabing cez ${match?.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.`;

  item.description = [prefix, base.description || ''].filter(Boolean).join(' ');
  return item;
}

async function buildCatalog({ type, id, skip = 0, config, configKey = '' }) {
  const def = catalogDef(id, type);
  if (!def) return { metas: [] };
  const normalizedSkip = Math.max(0, Number(skip || 0));
  const cacheKey = `catalog-v4:${configKey}:${type}:${id}:${normalizedSkip}`;
  const cached = getFreshCache(catalogCache, cacheKey, CATALOG_CACHE_TTL_MS);
  if (cached) return { ...cached, cache: 'hit' };

  const auth = await authProviders(config);
  if (!auth.fastshare.ok && !auth.webshare.ok) return { metas: [], auth: { fastshare: false, webshare: false } };

  const candidates = await catalogCandidates(type, def, normalizedSkip);
  const checked = await mapWithConcurrency(candidates, 3, async base => {
    try {
      const meta = await getMeta(type, base.id);
      const match = await availabilityForMeta(meta, type, def, auth);
      return match ? metaToCatalogItem(base, match, type, def) : null;
    } catch { return null; }
  });

  const value = {
    metas: checked.filter(Boolean).slice(0, CATALOG_PAGE_SIZE),
    auth: { fastshare: auth.fastshare.ok, webshare: auth.webshare.ok },
    generatedAt: new Date().toISOString(),
    source: def.source || 'cinemeta',
    tmdbEnabled: tmdbEnabled(),
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
  tmdbCandidates,
  catalogCandidates
};
