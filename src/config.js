'use strict';

const VERSION = '6.4.3';
const PORT = Number(process.env.PORT || 10000);
const BASE_URL = String(process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const API = 'https://fastshare.cz/api/api_kodi.php';

const MAX_STREAMS = Number(process.env.MAX_STREAMS || 60);
const MAX_SEARCH_TERMS = Number(process.env.MAX_SEARCH_TERMS || 24);
const PRIMARY_SEARCH_TERMS = Math.max(2, Math.min(10, Number(process.env.PRIMARY_SEARCH_TERMS || 6)));
const PRIMARY_MATCH_TARGET = Math.max(1, Number(process.env.PRIMARY_MATCH_TARGET || 6));
const MAX_TITLE_ALIASES = Math.max(4, Number(process.env.MAX_TITLE_ALIASES || 12));
const SEARCH_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.SEARCH_CONCURRENCY || 3)));

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 9000);
const FASTSHARE_SEARCH_TIMEOUT_MS = Number(process.env.FASTSHARE_SEARCH_TIMEOUT_MS || 7000);
const FASTSHARE_LOGIN_TIMEOUT_MS = Number(process.env.FASTSHARE_LOGIN_TIMEOUT_MS || 7000);
const FASTSHARE_SEARCH_CACHE_TTL_MS = Number(process.env.FASTSHARE_SEARCH_CACHE_TTL_MS || 1000 * 60 * 3);
const FASTSHARE_SEARCH_CACHE_MAX = Number(process.env.FASTSHARE_SEARCH_CACHE_MAX || 1000);

const METADATA_NEGATIVE_CACHE_TTL_MS = Number(process.env.METADATA_NEGATIVE_CACHE_TTL_MS || 1000 * 60 * 60 * 6);
const METADATA_CACHE_TTL_MS = Number(process.env.METADATA_CACHE_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const METADATA_CACHE_MAX = Number(process.env.METADATA_CACHE_MAX || 2000);

const TMDB_API_KEY = String(process.env.TMDB_API_KEY || '').trim();
const TMDB_READ_ACCESS_TOKEN = String(
  process.env.TMDB_READ_ACCESS_TOKEN ||
  process.env.TMDB_ACCESS_TOKEN ||
  process.env.TMDB_BEARER_TOKEN ||
  process.env.TMDB_TOKEN || ''
).trim();
const ENABLE_WIKIDATA_ALIASES = String(process.env.ENABLE_WIKIDATA_ALIASES || '1') !== '0';

const NARD_BADGES_URL = 'https://raw.githubusercontent.com/vowl313/NardBadges/refs/heads/main/NardBadges.json';
const LEGACY_NUVIO_BADGES_URL = 'https://gist.githubusercontent.com/saif1233/a2b9817bb8a632ae93a6076c1e1459af/raw/f61d444e1cc03e017ba9327a557b4be516e3a340/Nuvio.json';
const NUVIO_BASE_BADGES_URL = String(process.env.NUVIO_BASE_BADGES_URL || NARD_BADGES_URL).trim();
const NUVIO_BADGES_CACHE_TTL_MS = Number(process.env.NUVIO_BADGES_CACHE_TTL_MS || 1000 * 60 * 60 * 12);

module.exports = {
  VERSION,
  PORT,
  BASE_URL,
  API,
  MAX_STREAMS,
  MAX_SEARCH_TERMS,
  PRIMARY_SEARCH_TERMS,
  PRIMARY_MATCH_TARGET,
  MAX_TITLE_ALIASES,
  SEARCH_CONCURRENCY,
  HTTP_TIMEOUT_MS,
  FASTSHARE_SEARCH_TIMEOUT_MS,
  FASTSHARE_LOGIN_TIMEOUT_MS,
  FASTSHARE_SEARCH_CACHE_TTL_MS,
  FASTSHARE_SEARCH_CACHE_MAX,
  METADATA_NEGATIVE_CACHE_TTL_MS,
  METADATA_CACHE_TTL_MS,
  METADATA_CACHE_MAX,
  TMDB_API_KEY,
  TMDB_READ_ACCESS_TOKEN,
  ENABLE_WIKIDATA_ALIASES,
  NARD_BADGES_URL,
  LEGACY_NUVIO_BADGES_URL,
  NUVIO_BASE_BADGES_URL,
  NUVIO_BADGES_CACHE_TTL_MS
};
