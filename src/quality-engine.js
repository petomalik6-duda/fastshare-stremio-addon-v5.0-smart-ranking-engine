'use strict';

const crypto = require('crypto');
const ranking = require('./ranking');

const STREAM_CACHE_TTL_MS = Number(process.env.STREAM_RESPONSE_CACHE_TTL_MS || 1000 * 60 * 3);
const STREAM_CACHE_MAX = Number(process.env.STREAM_RESPONSE_CACHE_MAX || 500);
const PROVIDER_RESPONSE_TIMEOUT_MS = Number(process.env.PROVIDER_RESPONSE_TIMEOUT_MS || 5500);
const streamCache = new Map();
const repairQueue = new Map();

function cacheGet(key) {
  const hit = streamCache.get(key);
  if (!hit || Date.now() - hit.at > STREAM_CACHE_TTL_MS) {
    if (hit) streamCache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  streamCache.set(key, { at: Date.now(), value });
  while (streamCache.size > STREAM_CACHE_MAX) streamCache.delete(streamCache.keys().next().value);
}
function hashConfig(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}
function cacheKey(req) {
  return `${hashConfig(req.params?.config || 'public')}:${req.params?.type || ''}:${req.params?.id || ''}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ streams: [], timedOut: true, error: `${label} response timeout` }), ms);
  });
  return Promise.race([
    Promise.resolve(promise).catch(error => ({ streams: [], error: String(error?.message || error) })),
    timeout
  ]).finally(() => clearTimeout(timer));
}

function filenameOf(stream) {
  return String(stream?.behaviorHints?.filename || stream?.filename || stream?.title || '');
}
function providerOf(stream) {
  const text = `${stream?.name || ''} ${stream?.title || ''}`.toLowerCase();
  if (text.includes('webshare')) return 'Webshare';
  if (text.includes('fastshare')) return 'FastShare';
  return 'FastShare + Webshare';
}
function streamQualityScore(stream, runtime) {
  const name = filenameOf(stream);
  const evidence = runtime.dubbingEvidence ? runtime.dubbingEvidence(stream) : { any: false, evidence: 'none' };
  let score = 0;
  if (evidence.evidence === 'track-metadata') score += 900;
  else if (evidence.any) score += 700;
  if (/\b(2160p|4k|uhd)\b/i.test(name)) score += 320;
  else if (/\b1080p\b/i.test(name)) score += 220;
  else if (/\b720p\b/i.test(name)) score += 120;
  if (/\b(dolby\s*vision|dovi|\bdv\b)\b/i.test(name)) score += 75;
  if (/\b(hdr10\+?|hdr)\b/i.test(name)) score += 55;
  if (/\b(remux)\b/i.test(name)) score += 45;
  if (/\b(hevc|h265|x265|av1)\b/i.test(name)) score += 25;
  const size = Number(stream?.behaviorHints?.videoSize || 0);
  if (size > 0) score += Math.min(80, Math.log2(size / (1024 * 1024) + 1) * 7);
  return score;
}

function targetEpisode(id) {
  const parts = String(id || '').split(':');
  if (parts.length < 3) return null;
  const season = Number(parts[1]);
  const episode = Number(parts[2]);
  return season > 0 && episode > 0 ? { season, episode } : null;
}
function seriesStreamMatches(stream, id) {
  const target = targetEpisode(id);
  if (!target) return true;
  const name = filenameOf(stream);
  const parsed = ranking.parseSeriesRelease ? ranking.parseSeriesRelease(name) : { episodes: [], seasonPacks: [] };
  if (parsed.episodes?.length) {
    return parsed.episodes.some(entry => entry.season === target.season && entry.episodes.includes(target.episode));
  }
  // For a concrete episode request, season packs and loose series releases are not
  // returned as direct episode streams. This removes a common source of wrong playback.
  return false;
}

function normalizeStream(stream, runtime) {
  const sanitized = runtime.sanitizeStream ? runtime.sanitizeStream(stream) : stream;
  const provider = providerOf(sanitized);
  const hints = {
    ...(sanitized?.behaviorHints || {}),
    bingeGroup: 'fastshare-webshare-unified'
  };
  return {
    ...sanitized,
    name: 'FastShare + Webshare',
    title: String(sanitized?.title || '').replace(/^⭐?\s*(FastShare|Webshare)/i, provider),
    behaviorHints: hints,
    _provider: provider,
    _qualityScore: streamQualityScore(sanitized, runtime)
  };
}

function balancedSort(streams) {
  const sorted = streams.slice().sort((a, b) => b._qualityScore - a._qualityScore || Number(b.behaviorHints?.videoSize || 0) - Number(a.behaviorHints?.videoSize || 0));
  const out = [];
  let previous = '';
  let streak = 0;
  while (sorted.length) {
    let index = 0;
    if (streak >= 2) {
      const other = sorted.findIndex(item => item._provider !== previous);
      if (other >= 0) index = other;
    }
    const item = sorted.splice(index, 1)[0];
    if (item._provider === previous) streak += 1;
    else { previous = item._provider; streak = 1; }
    out.push(item);
  }
  return out.map(({ _provider, _qualityScore, ...stream }) => stream);
}

function compactProvider(result) {
  return {
    streamCount: Array.isArray(result?.streams) ? result.streams.length : 0,
    timedOut: Boolean(result?.timedOut),
    error: result?.error || null,
    auth: result?.auth ? { ok: result.auth.ok !== false, source: result.auth.source || null } : null,
    search: result?.search || null
  };
}

async function buildQualityResponse(runtime, req, debug = false) {
  const key = cacheKey(req);
  if (!debug) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cache: 'hit' };
  }

  const [fastshare, webshare] = await Promise.all([
    withTimeout(runtime.buildStreamResponse(req, debug), PROVIDER_RESPONSE_TIMEOUT_MS, 'FastShare'),
    withTimeout(runtime.buildWebshareStreams(req, debug), PROVIDER_RESPONSE_TIMEOUT_MS, 'Webshare')
  ]);
  const raw = [...(fastshare?.streams || []), ...(webshare?.streams || [])];
  const episodeFiltered = req.params?.type === 'series'
    ? raw.filter(stream => seriesStreamMatches(stream, req.params.id))
    : raw;
  const normalized = episodeFiltered.map(stream => normalizeStream(stream, runtime));
  const streams = balancedSort(normalized);

  const result = { streams, cache: 'miss' };
  if (!streams.length) {
    repairQueue.set(`${req.params?.type}:${req.params?.id}`, {
      at: Date.now(),
      type: req.params?.type,
      id: req.params?.id,
      reason: fastshare?.timedOut || webshare?.timedOut ? 'provider-timeout' : 'no-matching-stream'
    });
  } else {
    repairQueue.delete(`${req.params?.type}:${req.params?.id}`);
  }
  if (!debug) {
    cacheSet(key, result);
    return result;
  }

  let meta = null;
  try { meta = await runtime.getMeta(req.params.type, req.params.id); } catch {}
  const diagnostics = [];
  for (const providerResult of [fastshare, webshare]) {
    for (const file of providerResult?.files || []) {
      const match = ranking.titleMatchScore ? ranking.titleMatchScore(file.name || '', meta || {}, req.params.type) : null;
      diagnostics.push({
        provider: file.provider || 'unknown',
        filename: file.name,
        acceptedByTitle: match ? !match.reject : null,
        titleScore: match?.score ?? null,
        reasons: match?.reasons || [],
        dubbing: runtime.dubbingEvidence ? runtime.dubbingEvidence(file) : null,
        episodeMatch: req.params.type === 'series' ? seriesStreamMatches({ behaviorHints: { filename: file.name } }, req.params.id) : true
      });
    }
  }
  return {
    ok: true,
    type: req.params.type,
    id: req.params.id,
    meta: meta ? { title: meta.title, year: meta.year, aliases: ranking.getTitleAliases(meta).slice(0, 12) } : null,
    providers: { fastshare: compactProvider(fastshare), webshare: compactProvider(webshare) },
    rawStreamCount: raw.length,
    episodeFilteredCount: episodeFiltered.length,
    finalStreamCount: streams.length,
    streams,
    diagnostics: diagnostics.slice(0, 80),
    repairQueued: repairQueue.has(`${req.params?.type}:${req.params?.id}`)
  };
}

function install(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;
  const remove = new Set([
    '/stream/:type/:id.json', '/:config/stream/:type/:id.json',
    '/debug/stream/:type/:id.json', '/:config/debug/stream/:type/:id.json',
    '/debug/title/:type/:id.json', '/:config/debug/title/:type/:id.json'
  ]);
  app._router.stack = app._router.stack.filter(layer => !layer.route || !remove.has(layer.route.path));

  async function send(req, res) {
    if (req.params.config) res.set('Cache-Control', 'private, max-age=60');
    try { res.json(await buildQualityResponse(runtime, req, false)); }
    catch (error) { res.json({ streams: [], error: String(error?.message || error) }); }
  }
  async function debug(req, res) {
    res.set('Cache-Control', 'private, no-store');
    try { res.json(await buildQualityResponse(runtime, req, true)); }
    catch (error) { res.status(500).json({ ok: false, error: String(error?.stack || error) }); }
  }

  app.get('/stream/:type/:id.json', send);
  app.get('/:config/stream/:type/:id.json', send);
  app.get('/debug/stream/:type/:id.json', debug);
  app.get('/:config/debug/stream/:type/:id.json', debug);
  app.get('/debug/title/:type/:id.json', debug);
  app.get('/:config/debug/title/:type/:id.json', debug);
  app.get('/debug/repair-queue.json', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ count: repairQueue.size, items: [...repairQueue.values()].slice(-100) });
  });

  return {
    ...runtime,
    buildQualityResponse: req => buildQualityResponse(runtime, req, false),
    buildQualityDebug: req => buildQualityResponse(runtime, req, true),
    streamRepairQueue: repairQueue,
    streamResponseCache: streamCache
  };
}

module.exports = install;
