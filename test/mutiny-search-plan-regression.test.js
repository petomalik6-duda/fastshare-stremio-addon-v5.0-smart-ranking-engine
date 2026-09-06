'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchTermPlan } = require('../src/ranking');

const mutiny2026 = {
  type: 'movie',
  imdbId: 'tt32338669',
  title: 'Mutiny',
  year: 2026,
  raw: { name: 'Mutiny', releaseInfo: '2026' }
};

test('Mutiny 2026 search plan starts with title plus year', () => {
  const plan = searchTermPlan(mutiny2026);
  assert.equal(plan.primary[0], 'Mutiny 2026');
  assert.ok(plan.primary.includes('Mutiny'));
});
