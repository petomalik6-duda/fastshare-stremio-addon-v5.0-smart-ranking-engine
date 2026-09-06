'use strict';

const {
  VERSION,
  TMDB_API_KEY,
  TMDB_READ_ACCESS_TOKEN,
  ENABLE_WIKIDATA_ALIASES,
  METADATA_NEGATIVE_CACHE_TTL_MS,
  METADATA_CACHE_TTL_MS,
  METADATA_CACHE_MAX
} = require('./config');
const {
  normalize,
  uniqueStrings,
  getFreshCache,
  setCache,
  fetchJson
} = require('./utils');

const localizedMetaCache = new Map();
const cinemetaCache = new Map();
const CINEMETA_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

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
      if (!country || ['CZ', 'SK', 'CS'].includes(country)) {
        const language = country === 'CZ' || country === 'CS' ? 'cs' : (country === 'SK' ? 'sk' : '');
        addAlias(out, item.title || item.name, 'tmdb-alt', language);
      }
    }

    const translations = payload.translations?.translations || payload.translations || [];
    for (const item of Array.isArray(translations) ? translations : []) {
      const lang = String(item.iso_639_1 || '').toLowerCase();
      const country = String(item.iso_3166_1 || '').toUpperCase();
      if (!['cs', 'sk'].includes(lang) && !['CZ', 'SK', 'CS'].includes(country)) continue;
      const language = lang || (country === 'SK' ? 'sk' : 'cs');
      addAlias(out, item.data?.title || item.data?.name, 'tmdb-translation', language);
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
  const headers = { Accept: 'application/json', 'User-Agent': `FastShare-Stremio-Addon/${VERSION}` };
  if (TMDB_READ_ACCESS_TOKEN) headers.Authorization = `Bearer ${TMDB_READ_ACCESS_TOKEN}`;
  return { headers };
}

function tmdbUrl(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value != null) url.searchParams.set(key, value);
  }
  if (TMDB_API_KEY && !TMDB_READ_ACCESS_TOKEN) url.searchParams.set('api_key', TMDB_API_KEY);
  return url.toString();
}

async function fetchTmdbAliases(type, imdbId) {
  if (!TMDB_API_KEY && !TMDB_READ_ACCESS_TOKEN) return { aliases: [], source: 'tmdb-disabled' };
  const find = await fetchJson(
    tmdbUrl(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' }),
    tmdbRequestOptions()
  );
  const isSeries = type === 'series';
  const hit = isSeries ? find.tv_results?.[0] : find.movie_results?.[0];
  if (!hit?.id) return { aliases: [], source: 'tmdb-not-found' };

  const mediaPath = isSeries ? `/tv/${hit.id}` : `/movie/${hit.id}`;
  const [cs, sk] = await Promise.all([
    fetchJson(
      tmdbUrl(mediaPath, { language: 'cs-CZ', append_to_response: 'alternative_titles,translations' }),
      tmdbRequestOptions()
    ).then(value => ({ ...value, __language: 'cs' })),
    fetchJson(
      tmdbUrl(mediaPath, { language: 'sk-SK', append_to_response: 'alternative_titles,translations' }),
      tmdbRequestOptions()
    ).then(value => ({ ...value, __language: 'sk' }))
  ]);

  return {
    aliases: extractTmdbLocalizedAliases(type, [hit, cs, sk]),
    source: 'tmdb',
    tmdbId: hit.id
  };
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

  const payload = await fetchJson(url.toString(), {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': `FastShare-Stremio-Addon/${VERSION} (localized title lookup)`
    }
  });
  return { aliases: extractWikidataLocalizedAliases(payload), source: 'wikidata' };
}

async function getLocalizedTitleData(type, imdbId) {
  const cacheKey = `${type}:${imdbId}`;
  const cached = getFreshCache(localizedMetaCache, cacheKey, METADATA_CACHE_TTL_MS);
  if (cached) return { ...cached, cache: 'hit' };

  const sources = [];
  const aliases = [];
  let tmdbId = null;
  const tasks = [
    fetchTmdbAliases(type, imdbId).catch(error => ({
      aliases: [], source: 'tmdb-error', error: String(error.message || error)
    })),
    fetchWikidataAliases(imdbId).catch(error => ({
      aliases: [], source: 'wikidata-error', error: String(error.message || error)
    }))
  ];

  for (const result of await Promise.all(tasks)) {
    sources.push({
      source: result.source,
      count: result.aliases?.length || 0,
      ...(result.error ? { error: result.error } : {})
    });
    aliases.push(...(result.aliases || []));
    if (result.tmdbId) tmdbId = result.tmdbId;
  }

  const values = uniqueStrings(aliases.map(item => item.title));
  const value = { aliases: values, aliasDetails: aliases, sources, tmdbId, cache: 'miss' };
  const ttl = values.length ? METADATA_CACHE_TTL_MS : METADATA_NEGATIVE_CACHE_TTL_MS;
  setCache(localizedMetaCache, cacheKey, value, ttl, METADATA_CACHE_MAX);
  return value;
}

async function fetchCinemeta(type, imdbId) {
  const cacheKey = `${type}:${imdbId}`;
  const cached = getFreshCache(cinemetaCache, cacheKey, CINEMETA_CACHE_TTL_MS);
  if (cached) return cached;
  try {
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
    const json = await fetchJson(url, {
      headers: { 'User-Agent': `FastShare-Stremio-Addon/${VERSION}` }
    });
    const meta = json.meta || {};
    setCache(cinemetaCache, cacheKey, meta, CINEMETA_CACHE_TTL_MS, METADATA_CACHE_MAX);
    return meta;
  } catch (error) {
    return { name: imdbId, metadataError: String(error.message || error) };
  }
}

async function getMeta(type, id) {
  const parts = String(id || '').split(':');
  const clean = parts[0];
  const season = parts[1] ? Number(parts[1]) : null;
  const episode = parts[2] ? Number(parts[2]) : null;

  if (!clean.startsWith('tt')) {
    return {
      type,
      imdbId: clean,
      stremioId: id,
      title: clean,
      year: '',
      season,
      episode,
      raw: {},
      localizedAliases: [],
      localizedTitleData: { sources: [], aliasDetails: [] }
    };
  }

  const [meta, localized] = await Promise.all([
    fetchCinemeta(type, clean),
    getLocalizedTitleData(type, clean)
  ]);

  return {
    type,
    imdbId: clean,
    stremioId: id,
    title: meta.name || meta.title || clean,
    year: String(meta.year || meta.releaseInfo || '').slice(0, 4),
    season,
    episode,
    raw: meta,
    localizedAliases: localized.aliases,
    localizedTitleData: localized
  };
}

module.exports = {
  extractTmdbLocalizedAliases,
  extractWikidataLocalizedAliases,
  fetchTmdbAliases,
  fetchWikidataAliases,
  getLocalizedTitleData,
  getMeta
};
