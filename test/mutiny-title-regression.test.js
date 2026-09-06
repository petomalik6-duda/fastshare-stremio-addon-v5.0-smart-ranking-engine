'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { titleMatchScore } = require('../src/ranking');

const meta = {
  type: 'movie',
  imdbId: 'tt32338669',
  title: 'Mutiny',
  year: 2026,
  raw: { name: 'Mutiny', releaseInfo: '2026' }
};

test('Mutiny 2026 title/year is accepted by base title matcher', () => {
  const result = titleMatchScore('Mutiny.2026.1080p.WEB-DL.mkv', meta, 'movie');
  assert.equal(result.reject, false);
  assert.ok(result.score > 100);
});
