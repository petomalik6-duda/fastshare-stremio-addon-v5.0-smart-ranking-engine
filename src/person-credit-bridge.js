'use strict';

const { VERSION } = require('./config');
const { fetchJson, uniqueStrings } = require('./utils');
const { getMeta } = require('./metadata');

const DISCOVERY_BASE_URL = String(
  process.env.PEOPLE_DISCOVERY_BASE_URL ||
  'https://stremio-csfd-discovery-addon.onrender.com'
).replace(/\/$/, '');

const bridgeMetaCache = new Map();
const BRIDGE_META_TTL_MS = Number(process.env.PEOPLE_BRIDGE_META_TTL_MS || 1000 * 60 * 60 * 24);
const BRIDGE_META_CACHE_MAX = 1000;

function parsePersonCreditId(rawId = '') {
  const match = String(rawId).match(/^person-credit:(movie|series):(\d+)$/i);
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
    tmdbId: Number(match[2]),
    id: String(rawId)
  };
}

function cacheGet(key) {
  const hit = bridgeMetaCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > BRIDGE_META_TTL_MS) {
    bridgeMetaCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (bridgeMetaCache.size >= BRIDGE_META_CACHE_MAX) {
    const oldest = bridgeMetaCache.keys().next().value;
    if (oldest) bridgeMetaCache.delete(oldest);
  }
  bridgeMetaCache.set(key, { at: Date.now(), value });
}

async function fetchDiscoveryMeta(target) {
  const url = `${DISCOVERY_BASE_URL}/meta/${target.type}/tmdb:${target.type}:${target.tmdbId}.json`;
  const payload = await fetchJson(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': `FastShare-Webshare/${VERSION} PeopleBridge`
    }
  });
  return payload?.meta || null;
}

async function resolvePersonCreditMeta(rawId) {
  const target = parsePersonCreditId(rawId);
  if (!target) return null;

  const cached = cacheGet(target.id);
  if (cached) return { ...cached, bridgeCache: 'hit' };

  const discovery = await fetchDiscoveryMeta(target);
  if (!discovery) throw new Error(`People bridge metadata not found for ${target.id}`);

  const canonicalId = String(discovery.id || discovery.imdb_id || discovery.imdbId || '').trim();
  let base = null;
  if (/^tt\d+$/.test(canonicalId)) {
    try {
      base = await getMeta(target.type, canonicalId);
    } catch {
      base = null;
    }
  }

  const title = String(discovery.name || discovery.title || base?.title || canonicalId || target.id).trim();
  const releaseInfo = String(discovery.releaseInfo || discovery.year || base?.year || '');
  const yearMatch = releaseInfo.match(/\b(19\d{2}|20\d{2})\b/);
  const aliases = uniqueStrings([
    title,
    ...(base?.localizedAliases || []),
    base?.title,
    discovery.originalTitle,
    discovery.original_name,
    discovery.original_title
  ]);

  const value = {
    ...(base || {}),
    type: target.type,
    imdbId: /^tt\d+$/.test(canonicalId) ? canonicalId : (base?.imdbId || canonicalId || `tmdb:${target.tmdbId}`),
    stremioId: target.id,
    title,
    year: yearMatch ? yearMatch[1] : String(base?.year || ''),
    season: null,
    episode: null,
    raw: { ...(base?.raw || {}), ...discovery, bridgeTarget: target },
    localizedAliases: aliases,
    localizedTitleData: base?.localizedTitleData || {
      aliases,
      aliasDetails: aliases.map(alias => ({ title: alias, source: 'people-bridge', language: '' })),
      sources: [{ source: 'people-bridge', count: aliases.length }]
    },
    bridgeTarget: target,
    bridgeSource: 'csfd-discovery'
  };

  cacheSet(target.id, value);
  return { ...value, bridgeCache: 'miss' };
}

module.exports = {
  DISCOVERY_BASE_URL,
  parsePersonCreditId,
  resolvePersonCreditMeta
};
