'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  guardedRankFiles,
  hasExactSeriesTitleEvidence
} = require('../src/launcher');

const reacherWithAlias = {
  type: 'series',
  imdbId: 'tt9288030',
  stremioId: 'tt9288030:4:7',
  title: 'Reacher',
  season: 4,
  episode: 7,
  raw: { name: 'Reacher' },
  localizedAliases: ['Jack Reacher'],
  localizedTitleData: {
    aliasDetails: [{ title: 'Jack Reacher', language: 'en', source: 'test' }]
  }
};

test('rejects Preacher even when a multi-word Jack Reacher alias enables fuzzy evidence', () => {
  const wrongName = 'Preacher.S04E07.1080p.WEB-DL.CZ.Dabing.mkv';
  assert.equal(hasExactSeriesTitleEvidence(wrongName, reacherWithAlias), false);

  const ranked = guardedRankFiles([{
    name: wrongName,
    size: 3 * 1024 ** 3
  }], reacherWithAlias, 'series');

  assert.deepEqual(ranked, []);
});

test('keeps the correct Reacher episode', () => {
  const correctName = 'Reacher.S04E07.1080p.WEB-DL.CZ.Dabing.mkv';
  assert.equal(hasExactSeriesTitleEvidence(correctName, reacherWithAlias), true);

  const ranked = guardedRankFiles([{
    name: correctName,
    size: 3 * 1024 ** 3
  }], reacherWithAlias, 'series');

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].seriesKind, 'exact-episode');
});

test('keeps a valid relaxed exact-token match such as Thrones for Game of Thrones', () => {
  const meta = {
    type: 'series',
    imdbId: 'tt0944947',
    title: 'Game of Thrones',
    season: 1,
    episode: 2,
    raw: { name: 'Game of Thrones' },
    localizedAliases: []
  };

  const ranked = guardedRankFiles([{
    name: 'Thrones.S01E02.1080p.WEB-DL.mkv',
    size: 2 * 1024 ** 3
  }], meta, 'series');

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].seriesKind, 'exact-episode');
});
