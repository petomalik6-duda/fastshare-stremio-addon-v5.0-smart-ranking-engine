'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreFile, titleMatchScore } = require('../src/ranking');

const reacher = {
  type: 'series',
  imdbId: 'tt9288030',
  stremioId: 'tt9288030:4:7',
  title: 'Reacher',
  season: 4,
  episode: 7,
  raw: { name: 'Reacher' },
  localizedAliases: []
};

test('rejects Preacher S04E07 when requesting Reacher S04E07', () => {
  const wrong = titleMatchScore('Preacher.S04E07.1080p.WEB-DL.CZ.Dabing.mkv', reacher, 'series');
  assert.equal(wrong.reject, true);
  assert.match(wrong.reasons.join(' '), /weak-series-title reject/);

  const scored = scoreFile({
    name: 'Preacher.S04E07.1080p.WEB-DL.CZ.Dabing.mkv',
    size: 3 * 1024 ** 3
  }, reacher, 'series');
  assert.equal(scored, null);
});

test('keeps the correct Reacher S04E07 result', () => {
  const correct = scoreFile({
    name: 'Reacher.S04E07.1080p.WEB-DL.CZ.Dabing.mkv',
    size: 3 * 1024 ** 3
  }, reacher, 'series');
  assert.ok(correct);
  assert.equal(correct.seriesKind, 'exact-episode');
  assert.ok(correct.score > 200, `score was ${correct.score}`);
});

test('exact episode can still relax a multi-word series title when some title evidence exists', () => {
  const meta = {
    type: 'series',
    imdbId: 'tt0944947',
    title: 'Game of Thrones',
    season: 1,
    episode: 2,
    raw: { name: 'Game of Thrones' },
    localizedAliases: []
  };
  const result = scoreFile({
    name: 'Thrones.S01E02.1080p.WEB-DL.mkv',
    size: 2 * 1024 ** 3
  }, meta, 'series');
  assert.ok(result);
  assert.equal(result.seriesKind, 'exact-episode');
});
