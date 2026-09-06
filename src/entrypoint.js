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
  return nearestDifference > 2;
}

const MOVIE_RELEASE_MARKERS = new Set([
  '2160p', '1080p', '720p', '480p', '4k', 'uhd', 'hdr', 'dv', 'dolby',
  'web', 'webdl', 'webrip', 'bluray', 'brrip', 'hdrip', 'dvdrip', 'remux',
  'h264', 'h265', 'x264', 'x265', 'hevc', 'av1', 'mkv', 'mp4', 'avi', 'mov', 'm4v',
  'aac', 'ac3', 'eac3', 'dd', 'ddp', 'dts', 'truehd', 'atmos', 'flac', 'opus', 'mp3',
  'cz', 'cze', 'cs', 'cesky', 'czech', 'sk', 'svk', 'slovak', 'en', 'eng', 'english',
  'dab', 'dub', 'dabing', 'dubbing', 'audio', 'tit', 'titulky', 'sub', 'subs', 'forced',
  'proper', 'repack', 'extended', 'unrated', 'theatrical', 'directors', 'cut'
]);

function movieTitlePrefix(fileName) {
  const tokens = normalize(fileName).split(' ').filter(Boolean);
  const title = [];
  for (const token of tokens) {
    if (/^(19\d{2}|20\d{2})$/.test(token)) break;
    if (MOVIE_RELEASE_MARKERS.has(token)) break;
    title.push(token);
  }
  return title.join(' ').trim();
}

function oneWordMovieAliasCollision(fileName, meta, type) {
  if (type !== 'movie') return false;

  const aliases = ranking.getTitleAliases(meta);
  if (!aliases.length) return false;

  const candidates = aliases
    .map(alias => ({ alias, normalized: normalize(alias), ...ranking.aliasMatchScore(fileName, alias) }))
    .sort((a, b) => b.score - a.score || b.ratio - a.ratio);
  const best = candidates[0];

  // Only tighten candidates whose winning title evidence is a one-word alias.
  // Multi-word titles keep the normal ranking path.
  if (!best?.strong || !best.strictShortTitle) return false;

  const prefix = movieTitlePrefix(fileName);
  if (!prefix) return false;

  // A valid release title must equal one complete known alias before technical
  // release tags/year begin. This blocks cases such as "Stříbrná vzpoura" or
  // "Vzpoura na Bounty" from matching the one-word alias "Vzpoura" while still
  // keeping Mutiny/Vzpoura/Vzbura releases with normal release suffixes.
  const exactKnownTitle = aliases.some(alias => normalize(alias) === prefix);
  return !exactKnownTitle;
}

function guardedRankFiles(files, meta, type) {
  const ranked = baseRankFiles(files, meta, type);
  if (type === 'series') {
    return ranked.filter(file => !canonicalSeriesNearCollision(file?.name || '', meta, type));
  }
  if (type === 'movie') {
    return ranked.filter(file => {
      const name = file?.name || '';
      return !explicitMovieYearCollision(name, meta, type) && !oneWordMovieAliasCollision(name, meta, type);
    });
  }
  return ranked;
}

ranking.rankFiles = guardedRankFiles;

const runtime = require('./server');

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
  movieTitlePrefix,
  oneWordMovieAliasCollision,
  guardedRankFiles
};
