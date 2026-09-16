'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestedCandidates } = require('../src/catalog-requested-titles');
const { rankFiles } = require('../src/ranking');
const { hasCzSkAudio, qualityMatches } = require('../src/catalogs');
const { finalizePage } = require('../src/catalog-order');
const samples = require('./fixtures/catalog-discovery-gaps.json');

test('reported films are considered independently of the limited generic discovery sample', async () => {
  const metaFor = async (type, id) => {
    const sample = samples.find(x => x.id === id);
    return { title: sample.title, year: sample.year, raw: { releaseInfo: sample.year } };
  };
  const candidates = await requestedCandidates('movie', metaFor);
  assert.deepEqual(candidates.map(x => x.id), samples.map(x => x.id));
  const qualified = [];
  for (const candidate of candidates) {
    const sample = samples.find(x => x.id === candidate.id);
    const meta = { type: 'movie', imdbId: sample.id, title: sample.title, year: sample.year, localizedAliases: sample.aliases };
    const files = sample.files.map(file => ({ ...file, size: 1500000000 }));
    const dubbed = rankFiles(files, meta, 'movie').filter(hasCzSkAudio);
    assert.ok(dubbed.length > 0, `${sample.id} must retain its verified dubbed releases`);
    assert.ok(dubbed.every(file => !/titulky|cz tit\./i.test(file.name)));
    if (sample.id === 'tt27165187') assert.ok(dubbed.some(file => qualityMatches(file, '2160p')));
    if (sample.id === 'tt20424814') assert.ok(!dubbed.some(file => qualityMatches(file, '2160p')));
    qualified.push(candidate);
  }
  assert.equal(finalizePage(qualified, { mode: 'release' }).length, 2);
  assert.equal(finalizePage(qualified, { mode: 'release' })[0].id, 'tt27165187');
});

test('requested candidates do not substitute for availability and do not leak into series', async () => {
  assert.deepEqual(await requestedCandidates('series', () => { throw Error('should not fetch'); }), []);
  assert.deepEqual(await requestedCandidates('movie', async () => { throw Error('metadata unavailable'); }), []);
  assert.deepEqual(rankFiles([], { type: 'movie', title: 'Už vidím světlo', year: '2024' }, 'movie'), []);
});

test('requested localized candidates retain all normalized alias search terms', () => {
  const { searchTermPlan } = require('../src/ranking');
  const meta = { title: "I'm Beginning To See the Light", year: '2024', localizedAliases: ['Už vidím světlo'] };
  const plan = searchTermPlan(meta);
  assert.ok(plan.fallback.includes('uz vidim svetlo'));
  assert.ok(plan.fallback.includes('vidim svetlo'));
});
