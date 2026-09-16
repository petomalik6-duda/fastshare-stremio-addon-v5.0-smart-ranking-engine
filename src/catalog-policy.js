'use strict';

const PROVIDERS = new Set(['fastshare', 'webshare']);

function displayName(meta) {
  return String(meta?.name || meta?.title || meta?.raw?.name || meta?.raw?.title || '').trim();
}

function isDisplayableMeta(meta) {
  const name = displayName(meta);
  // Some internal test/fallback rows have no display name yet; only reject
  // the concrete bad state where an IMDb id was exposed as the title.
  return !/^tt\d+$/i.test(name) && !/^undefined$/i.test(name);
}

function hasProviderRecent(meta) {
  return PROVIDERS.has(String(meta?._providerSource || '').toLowerCase()) &&
    Number.isFinite(Number(meta?._providerRecentRank));
}

function recentDate(meta, now = Date.now()) {
  const values = meta?.type === 'series'
    ? [meta?._availableEpisodeDate, meta?._releaseDate, meta?.released, meta?.raw?.released]
    : [meta?._releaseDate, meta?.released, meta?.raw?.released];
  const value = values.find(item => String(item || '').trim());
  const day = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = Date.parse(day);
  const cutoff = now - 730 * 24 * 60 * 60 * 1000;
  return Number.isFinite(parsed) && parsed <= now && parsed >= cutoff;
}

function isRecentCatalogMeta(meta, now = Date.now()) {
  return Boolean(meta?._requestedCatalog || hasProviderRecent(meta) || recentDate(meta, now));
}

module.exports = { displayName, isDisplayableMeta, hasProviderRecent, recentDate, isRecentCatalogMeta };
