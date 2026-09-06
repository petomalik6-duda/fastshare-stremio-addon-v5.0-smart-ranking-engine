'use strict';

const crypto = require('crypto');
const {
  VERSION,
  API,
  FASTSHARE_SEARCH_TIMEOUT_MS,
  FASTSHARE_LOGIN_TIMEOUT_MS,
  FASTSHARE_SEARCH_CACHE_TTL_MS,
  FASTSHARE_SEARCH_CACHE_MAX
} = require('./config');
const {
  normalize,
  getFreshCache,
  setCache,
  fetchWithTimeout,
  esc
} = require('./utils');

const authCache = new Map();
const searchCache = new Map();
const AUTH_CACHE_TTL_MS = 1000 * 60 * 55;
const AUTH_CACHE_MAX = 200;

function mapFile(raw) {
  const name = raw?.filename || raw?.name || '';
  return {
    id: raw?.id,
    name,
    size: raw?.data?.value || raw?.size || 0,
    url: raw?.download_url || raw?.url,
    image: raw?.thumbnail,
    duration: raw?.duration?.value || raw?.duration || '',
    durationText: raw?.duration_f || '',
    resolution: raw?.resolution,
    raw
  };
}

function accountCacheKey(hash) {
  return crypto.createHash('sha1').update(String(hash || '')).digest('hex').slice(0, 16);
}

async function login(creds) {
  const username = String(creds?.username || '');
  const password = String(creds?.password || '');
  if (!username || !password) return { ok: false, error: 'missing credentials' };

  const cacheKey = crypto.createHash('sha1').update(`${username}:${password}`).digest('hex');
  const cached = getFreshCache(authCache, cacheKey, AUTH_CACHE_TTL_MS);
  if (cached) return { ok: true, hash: cached.hash, source: 'cache' };

  const url = `${API}?process=login&login=${esc(username)}&password=${esc(password)}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': `Kodi/20 FastShare Stremio/${VERSION}` }
    }, FASTSHARE_LOGIN_TIMEOUT_MS);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    const hash = json?.user?.hash || json?.hash || json?.data?.hash;
    if (!hash) {
      return {
        ok: false,
        status: res.status,
        error: res.ok ? 'login response did not contain session hash' : `FastShare login HTTP ${res.status}`,
        preview: text.slice(0, 300)
      };
    }
    setCache(authCache, cacheKey, { hash }, AUTH_CACHE_TTL_MS, AUTH_CACHE_MAX);
    return { ok: true, hash, source: 'login', status: res.status };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.name === 'AbortError' ? 'FastShare login timeout' : String(error.message || error)
    };
  }
}

function makeEmptySearch(term, extra = {}) {
  return {
    term,
    status: 0,
    resultCount: 0,
    apiUrl: `${API}?process=search&pagination=200&term=${esc(term)}&adult=0`,
    files: [],
    rawPreview: '',
    cache: 'miss',
    ...extra
  };
}

async function searchFastshare(term, hash) {
  const cleanTerm = String(term || '').trim();
  if (!cleanTerm || !hash) return makeEmptySearch(cleanTerm, { error: 'missing term or session' });

  const cacheKey = `${accountCacheKey(hash)}:${normalize(cleanTerm)}`;
  const cached = getFreshCache(searchCache, cacheKey, FASTSHARE_SEARCH_CACHE_TTL_MS);
  if (cached) return { ...cached, cache: 'hit' };

  const url = `${API}?process=search&pagination=200&term=${esc(cleanTerm)}&adult=0`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': `Kodi/20 FastShare Stremio/${VERSION}`,
        Cookie: `FASTSHARE=${hash}`
      }
    }, FASTSHARE_SEARCH_TIMEOUT_MS);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    const list = json?.search?.file || json?.file || json?.files || [];
    const value = {
      term: cleanTerm,
      status: res.status,
      resultCount: Array.isArray(list) ? list.length : 0,
      apiUrl: url,
      files: Array.isArray(list) ? list.map(mapFile) : [],
      rawPreview: text.slice(0, 500),
      cache: 'miss',
      ...(res.ok ? {} : { error: `FastShare search HTTP ${res.status}` })
    };

    // Cache only successful responses. A transient 429/5xx must be retried on the
    // next request rather than poisoning the cache for several minutes.
    if (res.ok) {
      const { cache, ...cacheable } = value;
      setCache(searchCache, cacheKey, cacheable, FASTSHARE_SEARCH_CACHE_TTL_MS, FASTSHARE_SEARCH_CACHE_MAX);
    }
    return value;
  } catch (error) {
    return makeEmptySearch(cleanTerm, {
      error: error?.name === 'AbortError' ? 'FastShare search timeout' : String(error.message || error),
      timedOut: error?.name === 'AbortError'
    });
  }
}

function streamUrl(file, hash) {
  const base = file?.url || file?.raw?.download_url;
  if (!base) return '';
  const sep = base.includes('?') ? '&' : '?';
  // Preserve the Kodi API playback format used by the working v6.3.x releases.
  return `${base}${sep}stream=1&session=${esc(hash)}&${esc(file.name)}`;
}

function clearSearchCache() {
  searchCache.clear();
}

module.exports = {
  login,
  searchFastshare,
  streamUrl,
  mapFile,
  clearSearchCache
};
