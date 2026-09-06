'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  guardedRankFiles,
  movieTitlePrefix,
  oneWordMovieAliasCollision
} = require('../src/entrypoint');

const mutiny = {
  type: 'movie',
  imdbId: 'tt32338669',
  title: 'Mutiny',
  year: 2026,
  releaseInfo: '2026',
  raw: { name: 'Mutiny', releaseInfo: '2026' },
  localizedAliases: ['Vzpoura', 'Vzbura'],
  localizedTitleData: {
    aliasDetails: [
      { title: 'Vzpoura', language: 'cs' },
      { title: 'Vzbura', language: 'sk' },
      { title: 'Mutiny', language: 'original' }
    ]
  }
};

function file(name) {
  return { name, size: 3 * 1024 ** 3 };
}

test('title prefix stops before technical release markers', () => {
  assert.equal(movieTitlePrefix('Vzpoura.2026.1080p.WEB-DL.CZ.Dabing.mkv'), 'vzpoura');
  assert.equal(movieTitlePrefix('Stříbrná.vzpoura.CZ.1080p.mkv'), 'stribrna vzpoura');
  assert.equal(movieTitlePrefix('Vzpoura.na.Bounty.1080p.mkv'), 'vzpoura na bounty');
});

test('rejects longer unrelated title containing Czech one-word alias', () => {
  const wrong = file('Stříbrná.vzpoura.CZ.1080p.mkv');
  assert.equal(oneWordMovieAliasCollision(wrong.name, mutiny, 'movie'), true);
  assert.equal(guardedRankFiles([wrong], mutiny, 'movie').length, 0);
});

test('rejects Vzpoura na Bounty when matching Mutiny through Vzpoura alias', () => {
  const wrong = file('Vzpoura.na.Bounty.1080p.CZ.mkv');
  assert.equal(oneWordMovieAliasCollision(wrong.name, mutiny, 'movie'), true);
  assert.equal(guardedRankFiles([wrong], mutiny, 'movie').length, 0);
});

test('keeps exact original, Czech and Slovak one-word titles', () => {
  for (const name of [
    'Mutiny.2026.1080p.WEB-DL.mkv',
    'Vzpoura.2026.1080p.CZ.Dabing.mkv',
    'Vzbura.2026.1080p.SK.Dabing.mkv',
    'Mutiny.1080p.WEB-DL.mkv'
  ]) {
    assert.equal(oneWordMovieAliasCollision(name, mutiny, 'movie'), false, name);
    assert.equal(guardedRankFiles([file(name)], mutiny, 'movie').length, 1, name);
  }
});
