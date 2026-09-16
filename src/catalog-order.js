'use strict';

function validTimestamp(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return 0;
  let time;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    time = Number(value);
    if (time < 1e12) time *= 1000;
  } else time = Date.parse(String(value));
  return Number.isFinite(time) && time >= Date.UTC(1900, 0, 1) && time <= now ? time : 0;
}

function releaseKey(meta, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  for (const value of [meta._releaseDate, meta.released, meta.raw?.released]) {
    const day = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const parsed = Date.parse(day);
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day || day > today) return '';
      return day;
    }
  }
  const year = String(meta.releaseInfo || meta.year || '').match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  return year && Number(year) <= new Date(now).getUTCFullYear() ? `${year}-00-00` : '';
}

function rank(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER; }
function addedKey(meta, now) {
  const upload = validTimestamp(meta._uploadedAt, now);
  if (upload) return [0, -upload, '', 0, 0, String(meta.id)];
  // Search ranks from different queries are not a shared chronological feed.
  const feed = meta._providerOrderKind === 'recent-feed';
  const source = meta._providerSource === 'webshare' ? 0 : meta._providerSource === 'fastshare' ? 1 : 2;
  const hasRank = rank(meta._providerFeedRank) !== Number.MAX_SAFE_INTEGER || rank(meta._providerRecentRank) !== Number.MAX_SAFE_INTEGER;
  return [feed ? 1 : hasRank ? 2 : 3, source, String(meta._providerFeedId || ''), rank(meta._providerFeedRank), rank(meta._providerRecentRank), String(meta.id)];
}
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}
function compareAdded(a, b, now = Date.now()) { return compareKeys(addedKey(a, now), addedKey(b, now)); }
function sortAdded(metas, now = Date.now()) { return metas.slice().sort((a, b) => compareAdded(a, b, now)); }
function sortRelease(metas, now = Date.now()) {
  return metas.slice().sort((a, b) => releaseKey(b, now).localeCompare(releaseKey(a, now)) || compareAdded(a, b, now));
}
function finalizePage(metas, { mode = 'added', skip = 0, limit = 100, now = Date.now() } = {}) {
  // Keep the newest qualifying file for a title; filter audio/quality before calling.
  const unique = new Map();
  for (const meta of sortAdded(metas.filter(m => m?.id), now)) {
    if (!unique.has(meta.id)) unique.set(meta.id, meta);
  }
  const rows = mode === 'release' ? sortRelease([...unique.values()], now) : [...unique.values()];
  return rows.slice(skip, skip + limit);
}

class SnapshotCache {
  constructor(ttl = 600000, max = 80) { this.ttl = ttl; this.max = max; this.entries = new Map(); }
  async get(key, build) {
    const hit = this.entries.get(key);
    if (hit && (!hit.at || Date.now() - hit.at < this.ttl)) return hit.promise;
    const entry = { at: 0 };
    entry.promise = Promise.resolve().then(build).then(value => { entry.at = Date.now(); return value; }).catch(error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
    return entry.promise;
  }
}
module.exports = { validTimestamp, releaseKey, compareAdded, sortAdded, sortRelease, finalizePage, SnapshotCache };
