'use strict';

const { CATALOGS } = require('./catalogs');

const PROFILE = [
  {
    id: 'unified-czsk-movies',
    type: 'movie',
    name: '🆕🇨🇿🇸🇰 Najnovšie dabované filmy',
    source: 'latest'
  },
  {
    id: 'unified-czsk-series',
    type: 'series',
    name: '🆕🇨🇿🇸🇰 Najnovšie dabované seriály',
    source: 'latest'
  },
  {
    id: 'unified-latest-movies',
    type: 'movie',
    name: '🆕 Najnovšie pridané filmy',
    source: 'latest',
    requireDub: false
  },
  {
    id: 'unified-latest-series',
    type: 'series',
    name: '🆕 Najnovšie pridané seriály',
    source: 'latest',
    requireDub: false
  },
  {
    id: 'unified-concerts',
    type: 'movie',
    name: '🎵 Koncerty',
    source: 'concerts',
    requireDub: false
  },
  {
    id: 'unified-4k-czsk',
    type: 'movie',
    name: '🎬 4K dabované nové filmy',
    source: 'latest',
    quality: '2160p'
  }
];

CATALOGS.splice(0, CATALOGS.length, ...PROFILE);

module.exports = { PROFILE, CATALOGS };
