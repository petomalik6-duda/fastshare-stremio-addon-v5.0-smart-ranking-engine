'use strict';

const { CATALOGS } = require('./catalogs');

const PROFILE = [
  {
    id: 'unified-search-movies',
    type: 'movie',
    name: '🔎 Vyhľadávanie filmov',
    source: 'search',
    requireDub: false
  },
  {
    id: 'unified-search-series',
    type: 'series',
    name: '🔎 Vyhľadávanie seriálov',
    source: 'search',
    requireDub: false
  },
  {
    id: 'unified-search-concerts',
    type: 'movie',
    name: '🔎 Vyhľadávanie koncertov',
    source: 'search',
    requireDub: false
  }
];

CATALOGS.splice(0, CATALOGS.length, ...PROFILE);

module.exports = { PROFILE, CATALOGS };
