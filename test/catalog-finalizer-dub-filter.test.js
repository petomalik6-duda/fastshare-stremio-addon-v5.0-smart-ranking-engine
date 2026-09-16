'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { strongDubMeta } = require('../src/catalog-finalizer');

test('dubbed new-release catalog keeps a recent Czech original', () => {
  assert.equal(strongDubMeta({ _nativeLocale: 'cz', _releaseDate: '2026-01-15', behaviorHints: { filename: 'Film 2026.mkv' } }), true);
});

test('dubbed new-release catalog rejects an old Czech original without audio evidence', () => {
  assert.equal(strongDubMeta({ _nativeLocale: 'cz', _releaseDate: '2020-01-15', behaviorHints: { filename: 'Film 2020.mkv' } }), false);
});

test('dubbed new-release catalog keeps explicit Czech audio evidence', () => {
  assert.equal(strongDubMeta({ _releaseDate: '2025-01-15', behaviorHints: { filename: 'Film 2025 CZ dabing.mkv' } }), true);
});

test('dubbed new-release catalog rejects an old foreign film even with Czech audio', () => {
  assert.equal(strongDubMeta({ _releaseDate: '2020-01-15', behaviorHints: { filename: 'Film 2020 CZ dabing.mkv' } }), false);
});

test('provider recent upload may retain an older film release', () => {
  assert.equal(strongDubMeta({ _releaseDate: '2020-01-15', _providerSource: 'fastshare', _providerRecentRank: 3, behaviorHints: { filename: 'Film 2020 CZ dabing.mkv' } }), true);
});

test('requested recovered title keeps provider-verified availability', () => {
  assert.equal(strongDubMeta({ _releaseDate: '2020-01-15', _requestedCatalog: true, behaviorHints: { filename: 'Film 2020 CZ dabing.mkv' } }), true);
});

test('series with a recent available episode is retained despite an old premiere', () => {
  assert.equal(strongDubMeta({ type: 'series', _releaseDate: '2010-01-15', _availableEpisodeDate: '2026-09-10', behaviorHints: { filename: 'Show S04E01 CZ dabing.mkv' } }), true);
});
