'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mediaContainerKey,
  rankFilesPreservingContainers
} = require('../src/entrypoint');

test('mediaContainerKey distinguishes browser-safe and Matroska variants', () => {
  assert.equal(mediaContainerKey({ name: 'Movie.2026.CZ.1080p.mp4' }), 'mp4');
  assert.equal(mediaContainerKey({ name: 'Movie.2026.CZ.1080p.mkv' }), 'mkv');
  assert.equal(mediaContainerKey({ ext: '.m4v', name: 'Movie' }), 'm4v');
});

test('ranking preserves equivalent MP4 and MKV releases as separate variants', () => {
  const meta = {
    type: 'movie',
    title: 'Avatar',
    year: '2009',
    releaseInfo: '2009',
    imdbId: 'tt0499549',
    raw: {}
  };
  const files = [
    {
      id: 'mkv',
      name: 'Avatar.2009.CZ.Dabing.1080p.mkv',
      size: 8 * 1024 * 1024 * 1024,
      url: 'https://data1.fastshare.cloud/avatar.mkv'
    },
    {
      id: 'mp4',
      name: 'Avatar.2009.CZ.Dabing.1080p.mp4',
      size: 7 * 1024 * 1024 * 1024,
      url: 'https://data1.fastshare.cloud/avatar.mp4'
    }
  ];

  const ranked = rankFilesPreservingContainers(files, meta, 'movie');
  const names = ranked.map(file => file.name);
  assert.equal(names.some(name => name.endsWith('.mkv')), true);
  assert.equal(names.some(name => name.endsWith('.mp4')), true);
});
