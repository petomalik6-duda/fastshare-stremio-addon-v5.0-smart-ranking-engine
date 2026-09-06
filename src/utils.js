'use strict';

const fetch = require('node-fetch');
const { HTTP_TIMEOUT_MS } = require('./config');

function normalize(value) {
  return String(value || '').toLowerCase()
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
  a = String(a || '');
  b = String(b || '');
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

function similarity(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const maxLen = Math.max(left.length, right.length);
  if (!maxLen) return 1;
  return 1 - (levenshtein(left, right) / maxLen);
}

function trimCache(map, maxEntries) {
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

function getFreshCache(map, key, ttlMs) {
  const entry = map.get(key);
  if (!entry) return null;
  const expiresAt = entry.expiresAt || (entry.ts + ttlMs);
  if (Date.now() > expiresAt) {
    map.delete(key);
    return null;
  }
  map.delete(key);
  map.set(key, entry);
  return entry.value;
}

function setCache(map, key, value, ttlMs, maxEntries) {
  map.delete(key);
  const ts = Date.now();
  map.set(key, { value, ts, expiresAt: ts + ttlMs });
  trimCache(map, maxEntries);
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

async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${safeUrlForError(url)}`);
  return await res.json();
}

function esc(value) {
  return encodeURIComponent(String(value || ''));
}

function bytesToHuman(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return i < 2 ? `${Math.round(x)} ${units[i]}` : `${x.toFixed(x >= 10 ? 0 : 1)} ${units[i]}`;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: String(error.message || error), item: items[index] };
      }
    }
  }
  if (!items.length) return [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

module.exports = {
  normalize,
  uniqueStrings,
  uniqueSearchTerms,
  levenshtein,
  similarity,
  trimCache,
  getFreshCache,
  setCache,
  safeUrlForError,
  fetchWithTimeout,
  fetchJson,
  esc,
  bytesToHuman,
  mapWithConcurrency
};
