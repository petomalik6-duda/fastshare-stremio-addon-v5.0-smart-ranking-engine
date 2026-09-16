'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareAdded, sortAdded, sortRelease, finalizePage, SnapshotCache, validTimestamp } = require('../src/catalog-order');
const now = Date.UTC(2026, 8, 16, 12);
const ids = rows => rows.map(x => x.id);

test('mixed-provider ordering is transitive and independent of input permutations', () => {
  const a = { id: 'a', _providerSource: 'webshare', _providerRecentRank: 1, _releaseDate: '2000-01-01' };
  const b = { id: 'b', _providerSource: 'webshare', _providerRecentRank: 2, _releaseDate: '2026-01-01' };
  const c = { id: 'c', _providerSource: 'fastshare', _releaseDate: '2020-01-01' };
  const rows = [a, b, c, { id: 'd', _uploadedAt: now - 1000 }, { id: 'e', _providerSource: 'webshare', _providerFeedRank: 0 }];
  for (const x of rows) for (const y of rows) for (const z of rows) {
    if (compareAdded(x, y, now) <= 0 && compareAdded(y, z, now) <= 0) assert.ok(compareAdded(x, z, now) <= 0);
  }
  for (const perm of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) assert.deepEqual(ids(sortAdded(perm, now)), ['a','b','c']);
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
