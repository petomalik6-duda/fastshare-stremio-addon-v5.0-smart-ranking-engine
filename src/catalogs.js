'use strict';

const { VERSION, SEARCH_CONCURRENCY } = require('./config');
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

async function cinemetaCandidates(type, skip = 0) {
  const url = `https://v3-cinemeta.strem.io/catalog/${type}/top.json?skip=${Math.max(0, Number(skip || 0))}`;
  const payload = await fetchJson(url, { headers: { 'User-Agent': `FastShare-Webshare/${VERSION}` } });
  return (Array.isArray(payload?.metas) ? payload.metas : []).slice(0, CANDIDATE_LIMIT);
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

  const ranked = rankFiles(files, meta, type)
    .filter(file => hasCzSkAudio(file, def.audio || null))
    .filter(file => qualityMatches(file, def.quality || null));

  return ranked[0] || null;
}

function metaToCatalogItem(base, match) {
  const item = {
    id: base.id,
    type: base.type,
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
    behaviorHints: { ...(base.behaviorHints || {}), defaultVideoId: base.id }
  };
  item.description = [
    match?.provider ? `Overený explicitný CZ/SK dabing cez ${match.provider === 'fastshare' ? 'FastShare' : 'Webshare'}.` : '',
    base.description || ''
  ].filter(Boolean).join(' ');
  return item;
}

async function buildCatalog({ type, id, skip = 0, config, configKey = '' }) {
  const def = catalogDef(id, type);
  if (!def) return { metas: [] };
  const normalizedSkip = Math.max(0, Number(skip || 0));
  const cacheKey = `strict-v2:${configKey}:${type}:${id}:${normalizedSkip}`;
  const cached = getFreshCache(catalogCache, cacheKey, CATALOG_CACHE_TTL_MS);
  if (cached) return { ...cached, cache: 'hit' };

  const auth = await authProviders(config);
  if (!auth.fastshare.ok && !auth.webshare.ok) return { metas: [], auth: { fastshare: false, webshare: false } };

  const candidates = await cinemetaCandidates(type, normalizedSkip);
  const checked = await mapWithConcurrency(candidates, 3, async base => {
    try {
      const meta = await getMeta(type, base.id);
      const match = await availabilityForMeta(meta, type, def, auth);
      return match ? metaToCatalogItem(base, match) : null;
    } catch { return null; }
  });

  const value = {
    metas: checked.filter(Boolean).slice(0, CATALOG_PAGE_SIZE),
    auth: { fastshare: auth.fastshare.ok, webshare: auth.webshare.ok },
    generatedAt: new Date().toISOString(),
    cache: 'miss'
  };
  setCache(catalogCache, cacheKey, value, CATALOG_CACHE_TTL_MS, CATALOG_CACHE_MAX);
  return value;
}

module.exports = { CATALOGS, catalogDef, buildCatalog, hasCzSkAudio, qualityMatches, strictDubLanguage };
