'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guardedRankFiles, canonicalSeriesNearCollision } = require('../src/entrypoint');

const pollutedReacher = {
  type: 'series',
  imdbId: 'tt9288030',
  stremioId: 'tt9288030:4:7',
  title: 'Reacher',
  season: 4,
  episode: 7,
  raw: { name: 'Reacher' },
  localizedAliases: ['Preacher'],
  localizedTitleData: {
    aliasDetails: [{ title: 'Preacher', language: 'en', source: 'synthetic-bad-provider' }]
  }
};

test('final guard rejects Preacher even if external metadata incorrectly supplies it as an alias', () => {
  const wrong = {
    name: 'Preacher.S04E07.1080p.WEB-DL.CZ.Dabing.mkv',
    size: 3 * 1024 ** 3
  };
  assert.equal(canonicalSeriesNearCollision(wrong.name, pollutedReacher, 'series'), true);
  assert.equal(guardedRankFiles([wrong], pollutedReacher, 'series').length, 0);
});

test('final guard keeps exact Reacher title', () => {
  const correct = {
    name: 'Reacher.S04E07.1080p.WEB-DL.CZ.Dabing.mkv',
    size: 3 * 1024 ** 3
  };
  assert.equal(canonicalSeriesNearCollision(correct.name, pollutedReacher, 'series'), false);
  const ranked = guardedRankFiles([correct], pollutedReacher, 'series');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].seriesKind, 'exact-episode');
});

test('final guard does not block a genuinely different localized one-word alias', () => {
  const localized = {
    type: 'series',
    imdbId: 'tt0000002',
    stremioId: 'tt0000002:1:2',
    title: 'Hunter',
    season: 1,
    episode: 2,
    raw: { name: 'Hunter' },
    localizedAliases: ['Lovec']
  };
  const file = {
    name: 'Lovec.S01E02.1080p.CZ.Dabing.mkv',
    size: 2 * 1024 ** 3
  };
  assert.equal(canonicalSeriesNearCollision(file.name, localized, 'series'), false);
  assert.equal(guardedRankFiles([file], localized, 'series').length, 1);
});
