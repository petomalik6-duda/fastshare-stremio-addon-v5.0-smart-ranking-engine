'use strict';

const ranking = require('./ranking');
const { normalize } = require('./utils');
const { PORT, VERSION } = require('./config');

const originalRankFiles = ranking.rankFiles;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'with', 'for', 'from'
]);
const GENERIC_SERIES_TOKENS = new Set([
  'live', 'concert', 'tour', 'show', 'performance', 'special', 'edition',
  'version', 'complete', 'full', 'movie', 'film', 'video', 'collection', 'pack',
  'season', 'series', 'episode', 'ep'
]);

function significantAliasTokens(meta) {
  const out = new Set();
  for (const alias of ranking.getTitleAliases(meta)) {
    for (const token of normalize(alias).split(' ').filter(Boolean)) {
      if (token.length < 3) continue;
      if (/^\d+$/.test(token)) continue;
      if (STOP_WORDS.has(token) || GENERIC_SERIES_TOKENS.has(token)) continue;
      out.add(token);
    }
  }
  return out;
}

function hasExactSeriesTitleEvidence(fileName, meta) {
  const expected = significantAliasTokens(meta);
  if (!expected.size) return true;
  const actual = new Set(normalize(fileName).split(' ').filter(Boolean));
  for (const token of expected) {
    if (actual.has(token)) return true;
  }
  return false;
}

function guardedRankFiles(files, meta, type) {
  const ranked = originalRankFiles(files, meta, type);
  if (type !== 'series') return ranked;

  return ranked.filter(file => {
    const reasons = Array.isArray(file?.scoreReasons) ? file.scoreReasons : [];
    const relaxed = reasons.some(reason => String(reason).includes('series-title-relaxed'));
    if (!relaxed) return true;
    return hasExactSeriesTitleEvidence(file.name, meta);
  });
}

// src/server.js destructures rankFiles during module load, so patch the export
// before requiring it. This adds a final safety gate without changing the core
// ranking engine and protects every series request handled by the live server.
ranking.rankFiles = guardedRankFiles;

const runtime = require('./server');

if (require.main === module) {
  runtime.app.listen(PORT, () => {
    console.log(`FastShare Stremio addon v${VERSION} on ${PORT} (series exact-token guard)`);
  });
}

module.exports = {
  ...runtime,
  guardedRankFiles,
  hasExactSeriesTitleEvidence,
  significantAliasTokens
};
