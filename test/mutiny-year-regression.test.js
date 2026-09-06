'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { explicitMovieYearCollision, guardedRankFiles } = require('../src/entrypoint');

const mutiny2026 = {
  type: 'movie',
  imdbId: 'tt32338669',
  stremioId: 'tt32338669',
  title: 'Mutiny',
  year: 2026,
  releaseInfo: '2026',
  runtime: '95 min',
  raw: { name: 'Mutiny', releaseInfo: '2026', runtime: '95 min' }
};

test('Mutiny 1952 is rejected for Mutiny 2026 even with strong CZ and quality bonuses', () => {
  const wrong = {
    name: 'Mutiny.1952.2160p.WEB-DL.CZ.Dabing.DDP5.1.mkv',
    size: 18 * 1024 ** 3,
    duration: 77 * 60
  };
  assert.equal(explicitMovieYearCollision(wrong.name, mutiny2026, 'movie'), true);
  assert.equal(guardedRankFiles([wrong], mutiny2026, 'movie').length, 0);
});

test('Mutiny 2026 remains accepted', () => {
  const correct = {
    name: 'Mutiny.2026.1080p.WEB-DL.CZ.Dabing.DDP5.1.mkv',
    size: 5 * 1024 ** 3,
    duration: 95 * 60
  };
  assert.equal(explicitMovieYearCollision(correct.name, mutiny2026, 'movie'), false);
  const ranked = guardedRankFiles([correct], mutiny2026, 'movie');
  assert.equal(ranked.length, 1);
  assert.match(ranked[0].name, /Mutiny\.2026/);
});

test('yearless Mutiny release is retained as a fallback', () => {
  const fallback = {
    name: 'Mutiny.1080p.WEB-DL.EN.DDP5.1.mkv',
    size: 4 * 1024 ** 3,
    duration: 95 * 60
  };
  assert.equal(explicitMovieYearCollision(fallback.name, mutiny2026, 'movie'), false);
  assert.equal(guardedRankFiles([fallback], mutiny2026, 'movie').length, 1);
});

test('small release-year offsets remain allowed for festival/theatrical differences', () => {
  assert.equal(explicitMovieYearCollision('Mutiny.2025.1080p.mkv', mutiny2026, 'movie'), false);
  assert.equal(explicitMovieYearCollision('Mutiny.2024.1080p.mkv', mutiny2026, 'movie'), false);
  assert.equal(explicitMovieYearCollision('Mutiny.2023.1080p.mkv', mutiny2026, 'movie'), true);
});

test('Mutiny on the Bounty 1962 is rejected for Mutiny 2026 when year is explicit', () => {
  const wrong = {
    name: 'Mutiny.on.the.Bounty.1962.1080p.BluRay.mkv',
    size: 8 * 1024 ** 3
  };
  assert.equal(explicitMovieYearCollision(wrong.name, mutiny2026, 'movie'), true);
  assert.equal(guardedRankFiles([wrong], mutiny2026, 'movie').length, 0);
});
