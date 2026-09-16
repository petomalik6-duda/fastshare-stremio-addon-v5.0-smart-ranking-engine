'use strict';

const ranking = require('./ranking');
const { normalize, levenshtein, similarity } = require('./utils');
const { PORT } = require('./config');

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
  if (!years.length || years.includes(expectedYear)) return false;
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
  if (!best?.strong || !best.strictShortTitle) return false;
  const prefix = movieTitlePrefix(fileName);
  if (!prefix) return false;
  const exactKnownTitle = aliases.some(alias => normalize(alias) === prefix);
  return !exactKnownTitle;
}

function guardedRankFiles(files, meta, type) {
  const ranked = baseRankFiles(files, meta, type);
  if (type === 'series') return ranked.filter(file => !canonicalSeriesNearCollision(file?.name || '', meta, type));
  if (type === 'movie') {
    return ranked.filter(file => {
      const name = file?.name || '';
      return !explicitMovieYearCollision(name, meta, type) && !oneWordMovieAliasCollision(name, meta, type);
    });
  }
  return ranked;
}

ranking.rankFiles = guardedRankFiles;

const runtime = require('./unified-server');
require('./configure-fix')(runtime);
require('./runtime-fix-v72')(runtime);
const compatibleRuntime = require('./manifest-compat')(runtime);
const strictRuntime = require('./strict-audio-fix')(compatibleRuntime);
const providerRuntime = require('./provider-stream-mode')(strictRuntime);
const concertRuntime = require('./concert-direct-catalog')(providerRuntime);
const enrichedConcertRuntime = require('./concert-metadata-overlay')(concertRuntime);
const referenceConcertRuntime = require('./concert-reference-catalog')(enrichedConcertRuntime);
const concertCompatRuntime = require('./concert-discovery-compat')(referenceConcertRuntime);
const providerRecentRuntime = require('./provider-recent-catalog')(concertCompatRuntime);
const superConcertRuntime = require('./concert-super-catalog')(providerRecentRuntime);
const mergedCatalogRuntime = require('./provider-recent-merge')(superConcertRuntime);
const qualityRuntime = require('./quality-engine')(mergedCatalogRuntime);
const finalRuntime = require('./catalog-finalizer')(qualityRuntime);

finalRuntime.app.get('/deploy-info', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: '7.18.16',
    entrypoint: 'src/entrypoint.js',
    runtime: 'FastShare+Webshare unified v71814',
    configurator: 'server-side',
    manifestCompat: true,
    strictDubCatalogs: true,
    strictDubEvidence: 'final-catalog-recheck: explicit-dub-or-audio-codec-or-track-metadata; native-czsk-originals-allowed-separately',
    bareAudioLabelIsDub: false,
    strictSeriesDubEvidence: true,
    strictEpisodeMatching: true,
    falseDubSeriesBlocklist: true,
    combinedProviderStreams: true,
    singleStreamSourceName: true,
    providerBalanced: true,
    streamSort: 'dub-evidence,quality,dv-hdr,remux-codec,size,provider-balanced',
    streamResponseCache: true,
    providerTimeoutFallback: true,
    providerResponseTimeoutMs: Number(process.env.PROVIDER_RESPONSE_TIMEOUT_MS || 5500),
    providerNativeRecentCatalogs: true,
    providerNativeRecentSources: 'webshare-recent+fastshare-fallback',
    providerRecentMergedWithFallback: true,
    catalogFinalizer: true,
    catalogFinalizerMode: 'evidence-preserving+total-order+snapshot-pagination',
    catalogCacheControl: 'no-store',
    dubbedMovieCatalogSort: 'release-date-desc-valid-past-only',
    dubbedSeriesCatalogSort: 'upload-or-matched-episode-date-or-title-date',
    latestAddedCatalogSort: 'verified-upload-time; matched-episode-or-title-date-fallback; search-rank-last',
    nativeCzSkOriginalsIncluded: true,
    expandedConcertDiscovery: true,
    concertMainSort: 'alphabetical',
    concertNewSort: 'release-date-desc',
    catalogDiagnostics: true,
    catalogOrderTopDiagnostics: true,
    webshareRecentSort: true,
    diagnosticTitleRoute: true,
    repairQueue: true,
    providerNativeConcertCatalog: true,
    concertProviderDiscoveryCompat: true,
    concertTmdbMetadata: true,
    concertWikipediaFallback: true,
    referenceConcertCatalog: true,
    concertSuperCatalog: true,
    concertDeduplication: true,
    csfdSearchLink: true,
    renderGitCommit: process.env.RENDER_GIT_COMMIT || null,
    renderServiceName: process.env.RENDER_SERVICE_NAME || null,
    renderExternalUrl: process.env.RENDER_EXTERNAL_URL || null
  });
});

function start() {
  return finalRuntime.app.listen(PORT, () => {
    console.log(`FastShare + Webshare Stremio addon v7.18.16 on ${PORT}`);
  });
}

if (require.main === module) start();

module.exports = {
  ...finalRuntime,
  start,
  canonicalSeriesNearCollision,
  explicitMovieYearCollision,
  movieTitlePrefix,
  oneWordMovieAliasCollision,
  guardedRankFiles
};
