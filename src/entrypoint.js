'use strict';

const ranking = require('./ranking');
const { normalize, levenshtein, similarity } = require('./utils');
const { PORT, VERSION } = require('./config');

const baseRankFiles = ranking.rankFiles;

function canonicalSeriesNearCollision(fileName, meta, type) {
  if (type !== 'series') return false;

  const canonical = normalize(meta?.title || '');
  const canonicalTokens = canonical.split(' ').filter(Boolean);
  if (canonicalTokens.length !== 1) return false;

  const expected = canonicalTokens[0];
  if (expected.length < 5) return false;

  const fileTokens = normalize(fileName).split(' ').filter(Boolean);
  if (fileTokens.includes(expected)) return false;

  // Final safety net for one-word series. If a release contains a token that is
  // only a near-spelling of the canonical title (Reacher -> Preacher, etc.) but
  // not the exact canonical token, reject it even if an external metadata alias
  // accidentally claims that spelling as a valid title.
  return fileTokens.some(actual => {
    if (actual === expected || actual.length < 5) return false;
    if (Math.abs(actual.length - expected.length) > 2) return false;
    const distance = levenshtein(expected, actual);
    if (distance > 2) return false;
    return similarity(expected, actual) >= 0.80;
  });
}

function explicitMovieYearCollision(fileName, meta, type) {
  if (type !== 'movie') return false;

  const expectedMatch = String(meta?.year || meta?.releaseInfo || meta?.raw?.releaseInfo || '').match(/\b(19\d{2}|20\d{2})\b/);
  if (!expectedMatch) return false;
  const expectedYear = Number(expectedMatch[1]);

  const years = [...String(fileName || '').matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(match => Number(match[1]));
  if (!years.length) return false;
  if (years.includes(expectedYear)) return false;

  const nearestDifference = Math.min(...years.map(year => Math.abs(year - expectedYear)));

  // A movie can legitimately have a festival/theatrical year offset of one or
  // occasionally two years. Anything farther away is a different release when
  // the filename states the year explicitly. This prevents high audio/quality
  // bonuses from reviving an old same-title movie (e.g. Mutiny 1952 vs 2026).
  return nearestDifference > 2;
}

function guardedRankFiles(files, meta, type) {
  const ranked = baseRankFiles(files, meta, type);
  if (type === 'series') {
    return ranked.filter(file => !canonicalSeriesNearCollision(file?.name || '', meta, type));
  }
  if (type === 'movie') {
    return ranked.filter(file => !explicitMovieYearCollision(file?.name || '', meta, type));
  }
  return ranked;
}

// Patch the export before loading src/server.js. src/server.js destructures
// rankFiles during module initialization, so both npm start and the legacy root
// server entrypoint use this guarded implementation.
ranking.rankFiles = guardedRankFiles;

const runtime = require('./server');

// Extra deployment diagnostics. This lets us distinguish the GitHub version from
// the code actually running on Render without exposing credentials.
runtime.app.get('/deploy-info', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: VERSION,
    entrypoint: 'src/entrypoint.js',
    renderGitCommit: process.env.RENDER_GIT_COMMIT || null,
    renderServiceName: process.env.RENDER_SERVICE_NAME || null,
    renderExternalUrl: process.env.RENDER_EXTERNAL_URL || null
  });
});

function start() {
  return runtime.app.listen(PORT, () => {
    console.log(`FastShare Stremio addon v${VERSION} on ${PORT} (guarded entrypoint)`);
  });
}

if (require.main === module) start();

module.exports = {
  ...runtime,
  start,
  canonicalSeriesNearCollision,
  explicitMovieYearCollision,
  guardedRankFiles
};
