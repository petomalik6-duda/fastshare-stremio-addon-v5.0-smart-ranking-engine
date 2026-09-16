'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareAdded, sortAdded, sortRelease, finalizePage, SnapshotCache, validTimestamp } = require('../src/catalog-order');
const now = Date.UTC(2026, 8, 16, 12);
const ids = rows => rows.map(x => x.id);
const { availableEpisodeDate } = require('../src/catalog-availability-date');

test('production regression: undated Mentalist and Leftovers search hits must not precede new dated titles', () => {
  const rows = [
    { id: 'mentalist', type: 'series', _releaseDate: '2008-09-23', _providerSource: 'fastshare', _providerFeedRank: 0, _providerRecentRank: 10 },
    { id: 'leftovers', type: 'series', _releaseDate: '2014-06-29', _providerSource: 'fastshare', _providerFeedRank: 1, _providerRecentRank: 3 },
    { id: 'mesto-krve', type: 'series', _releaseDate: '2026-09-16', _providerSource: 'fastshare' },
    { id: 'native', type: 'series', _releaseDate: '2026-09-10', _nativeLocale: 'cz' }
  ];
  assert.deepEqual(ids(finalizePage(rows, { now })), ['mesto-krve', 'native', 'leftovers', 'mentalist']);
  assert.deepEqual(ids(finalizePage(rows.reverse(), { now })), ['mesto-krve', 'native', 'leftovers', 'mentalist']);
});

test('episode fallback uses only episodes contained in the available file', () => {
  const meta = { raw: { videos: [
    { season: 1, episode: 1, released: '2008-09-23' },
    { season: 7, episode: 1, released: '2014-11-30' },
    { season: 8, episode: 1, released: '2026-09-15' },
    { season: 8, episode: 2, released: '2027-01-01' }
  ] } };
  assert.equal(availableEpisodeDate(meta, 'Show_S01E01_CZ.mkv', now), '2008-09-23');
  assert.equal(availableEpisodeDate(meta, 'Show.S08E01E02.CZ.mkv', now), '2026-09-15');
  assert.equal(availableEpisodeDate(meta, 'Show S07 complete CZ.mkv', now), '2014-11-30');
  assert.equal(availableEpisodeDate(meta, 'Show x265 CZ.mkv', now), '');
  assert.equal(availableEpisodeDate(meta, 'Show S09E01 CZ.mkv', now), '');
  const old = { id: 'old', type: 'series', _releaseDate: '2008-01-01', _availableEpisodeDate: availableEpisodeDate(meta, 'Show S08E01 CZ.mkv', now) };
  const recent = { id: 'recent', type: 'series', _releaseDate: '2026-09-10' };
  assert.deepEqual(ids(sortAdded([recent, old], now)), ['old', 'recent']);
});

test('discovery provenance does not outrank movie date; known uploads still lead', () => {
  const rows = [
    { id: 'old-search', type: 'movie', _releaseDate: '2025-06-23', _providerSource: 'fastshare', _providerFeedRank: 0 },
    { id: 'new-fallback', type: 'movie', _releaseDate: '2026-09-10' },
    { id: 'known-upload', type: 'movie', _releaseDate: '2000-01-01', _uploadedAt: now - 1000 }
  ];
  assert.deepEqual(ids(sortAdded(rows, now)), ['known-upload', 'new-fallback', 'old-search']);
});

test('mixed-provider ordering is transitive and independent of input permutations', () => {
  const a = { id: 'a', _providerSource: 'webshare', _providerRecentRank: 1, _releaseDate: '2000-01-01' };
  const b = { id: 'b', _providerSource: 'webshare', _providerRecentRank: 2, _releaseDate: '2026-01-01' };
  const c = { id: 'c', _providerSource: 'fastshare', _releaseDate: '2020-01-01' };
  const rows = [a, b, c, { id: 'd', _uploadedAt: now - 1000 }, { id: 'e', _providerSource: 'webshare', _providerFeedRank: 0 }];
  for (const x of rows) for (const y of rows) for (const z of rows) {
    if (compareAdded(x, y, now) <= 0 && compareAdded(y, z, now) <= 0) assert.ok(compareAdded(x, z, now) <= 0);
  }
  for (const perm of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) assert.deepEqual(ids(sortAdded(perm, now)), ['b','c','a']);
});

test('a newly available episode updates an old series; premiere sorting remains separate', () => {
  const rows = [
    { id: 'old-series', _releaseDate: '2003-01-01', _uploadedAt: now - 1000 },
    { id: 'new-series', _releaseDate: '2026-01-01', _uploadedAt: now - 100000 },
    { id: 'old-series', _releaseDate: '2003-01-01', _uploadedAt: now - 200000 }
  ];
  assert.deepEqual(ids(finalizePage(rows, { now })), ['old-series','new-series']);
  assert.deepEqual(ids(finalizePage(rows, { now, mode: 'release' })), ['new-series','old-series']);
});

test('all candidates are sorted before pagination; consecutive pages do not repeat titles', () => {
  const rows = Array.from({ length: 225 }, (_, i) => ({ id: `tt${i}`, _uploadedAt: now - (225-i)*1000 }));
  rows.push({ ...rows[224], _uploadedAt: now - 300000 });
  const options = { now, limit: 100 };
  const first = finalizePage(rows, options), second = finalizePage(rows, { ...options, skip: 100 });
  assert.equal(first[0].id, 'tt224');
  assert.equal(first.length, 100);
  assert.equal(second.length, 100);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 200);
  assert.equal(finalizePage(rows, { ...options, skip: 200 }).length, 25);
});

test('invalid and future dates cannot be promoted to today', () => {
  const rows = [{ id: 'future', _releaseDate: '2027-01-01' }, { id: 'valid', _releaseDate: '2026-09-15' }, { id: 'invalid', _releaseDate: '2026-02-30' }];
  assert.equal(sortRelease(rows, now)[0].id, 'valid');
  assert.equal(validTimestamp(now + 1000, now), 0);
  assert.equal(validTimestamp('broken', now), 0);
  assert.equal(validTimestamp(Math.floor(now / 1000), now), now);
});

test('snapshots share an in-flight build, isolate accounts and recover after failures', async () => {
  const cache = new SnapshotCache(600000, 80);
  let calls = 0;
  const build = async () => { calls++; return ['stable']; };
  assert.deepEqual(await Promise.all([cache.get('account-a', build), cache.get('account-a', build)]), [['stable'], ['stable']]);
  assert.equal(calls, 1);
  await cache.get('account-b', build);
  assert.equal(calls, 2);
  await assert.rejects(cache.get('failure', async () => { throw Error('transient'); }));
  assert.deepEqual(await cache.get('failure', build), ['stable']);
});

test('final production catalog handler slices one sorted pool and retains track evidence', async () => {
  const install = require('../src/catalog-finalizer');
  const pool = Array.from({ length: 150 }, (_, i) => ({ id: `tt${i}`, type: 'movie', _releaseDate: '2026-01-01', _uploadedAt: now - (150-i)*1000,
    behaviorHints: { filename: 'Movie.mkv' }, _audioEvidence: { key: 'CZ', evidence: 'track-metadata', verifiedAudio: true } }));
  pool.unshift({ id: 'tt149', type: 'movie', _uploadedAt: now, behaviorHints: { filename: 'Movie.CZ.titulky.mkv' } });
  const app = { _router: { stack: [] }, get() {} };
  let calls = 0;
  const runtime = install({ app, unifiedConfig: () => ({}), sendCatalog: async (req, res) => { calls++; res.json({ metas: pool }); } });
  const request = skip => ({ params: { type: 'movie', id: 'unified-4k-czsk', extra: `skip=${skip}` } });
  const first = await runtime.buildFinalCatalog(request(0));
  const second = await runtime.buildFinalCatalog(request(100));
  assert.equal(first.metas.length, 100);
  assert.equal(second.metas.length, 50);
  assert.equal(first.metas[0].id, 'tt149');
  assert.equal(new Set([...ids(first.metas), ...ids(second.metas)]).size, 150);
  assert.equal(calls, 1);
});
