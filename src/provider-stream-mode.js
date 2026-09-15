'use strict';

const { login: fastshareLogin, searchFastshare, streamUrl: fastshareStreamUrl } = require('./fastshare');
const { login: webshareLogin, searchWebshare, streamUrl: webshareStreamUrl } = require('./webshare');
const { mapWithConcurrency, bytesToHuman, normalize } = require('./utils');
const { detectAudio, detectQuality } = require('./ranking');

function decodeConcertId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('concert:')) return '';
  try { return Buffer.from(raw.slice(8), 'base64url').toString('utf8'); }
  catch { return ''; }
}

function installProviderStreamMode(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  const paths = new Set([
    '/stream/:type/:id.json',
    '/:config/stream/:type/:id.json',
    '/debug/stream/:type/:id.json',
    '/:config/debug/stream/:type/:id.json'
  ]);
  app._router.stack = app._router.stack.filter(layer => !layer.route || !paths.has(layer.route.path));

  function dubbingRank(stream) {
    const text = `${stream?.name || ''} ${stream?.title || ''} ${stream?.behaviorHints?.filename || ''}`.toLowerCase();
    if (/cz\s*\/\s*sk\s*(dabing|dub|dubbing)|cz\/sk\s*dabing|cz-sk\s*dabing/.test(text)) return 4;
    if (/\bcz\s*(dabing|dub|dubbing)\b|\bczech\s*(audio|dub|dubbing)\b/.test(text)) return 3;
    if (/\bsk\s*(dabing|dub|dubbing)\b|\bslovak\s*(audio|dub|dubbing)\b/.test(text)) return 3;
    if (/\bcz\s*audio\b|\bsk\s*audio\b/.test(text)) return 2;
    if (/\bdabing\b|\bdubbed\b|\bdubbing\b/.test(text)) return 1;
    return 0;
  }

  function streamSize(stream) {
    return Number(stream?.behaviorHints?.videoSize || 0);
  }

  function providerOf(stream) {
    const title = String(stream?.title || '').toLowerCase();
    if (title.includes('[webshare]')) return 'webshare';
    if (title.includes('[fastshare]')) return 'fastshare';
    const name = String(stream?.name || '').toLowerCase();
    return name.includes('webshare') ? 'webshare' : 'fastshare';
  }

  function labelProvider(stream, provider) {
    const tag = provider === 'webshare' ? 'Webshare' : 'FastShare';
    const title = String(stream?.title || '');
    const taggedTitle = title.startsWith(`[${tag}]`) ? title : `[${tag}] ${title}`;
    return {
      ...stream,
      // One identical name forces Nuvio/Stremio to present both providers as one source list.
      name: 'FastShare + Webshare',
      title: taggedTitle
    };
  }

  function prepare(streams, provider) {
    return (streams || [])
      .map(stream => runtime.sanitizeStream ? runtime.sanitizeStream(stream) : stream)
      .filter(Boolean)
      .map(stream => labelProvider(stream, provider));
  }

  function balancedGroup(group) {
    const fast = group.filter(s => providerOf(s) === 'fastshare').sort((a, b) => streamSize(b) - streamSize(a));
    const web = group.filter(s => providerOf(s) === 'webshare').sort((a, b) => streamSize(b) - streamSize(a));
    const out = [];
    let streakProvider = null;
    let streak = 0;
    while (fast.length || web.length) {
      const f = fast[0], w = web[0];
      let pick;
      if (!f) pick = 'webshare';
      else if (!w) pick = 'fastshare';
      else {
        const natural = streamSize(f) >= streamSize(w) ? 'fastshare' : 'webshare';
        const other = natural === 'fastshare' ? 'webshare' : 'fastshare';
        pick = streakProvider === natural && streak >= 2 ? other : natural;
      }
      const chosen = pick === 'fastshare' ? fast.shift() : web.shift();
      if (!chosen) continue;
      out.push(chosen);
      if (streakProvider === pick) streak++; else { streakProvider = pick; streak = 1; }
    }
    return out;
  }

  function sortCombined(streams) {
    const groups = new Map();
    for (const stream of streams || []) {
      const rank = dubbingRank(stream);
      if (!groups.has(rank)) groups.set(rank, []);
      groups.get(rank).push(stream);
    }
    const out = [];
    for (const rank of [4, 3, 2, 1, 0]) if (groups.has(rank)) out.push(...balancedGroup(groups.get(rank)));
    return out;
  }

  function titleMatch(name, query) {
    const a = normalize(name);
    const b = normalize(query);
    if (!a || !b) return false;
    const tokens = b.split(' ').filter(t => t.length >= 3 && !['live','concert','tour','world','the','and'].includes(t));
    return a.includes(b) || (tokens.length >= 2 && tokens.filter(t => a.includes(t)).length >= Math.ceil(tokens.length * 0.7));
  }

  function directStreamObject(file, provider, url) {
    const audio = detectAudio(file.name || '');
    const quality = detectQuality(file.name || '');
    const size = bytesToHuman(file.size || 0);
    const title = `[${provider === 'webshare' ? 'Webshare' : 'FastShare'}] ${file.name}\n${[quality, size, audio.label].filter(Boolean).join(' • ')}`;
    return {
      name: 'FastShare + Webshare',
      title,
      url,
      behaviorHints: {
        filename: file.name,
        videoSize: Number(file.size || 0) || undefined,
        bingeGroup: `combined-concert-${provider}`
      }
    };
  }

  async function buildConcert(req, debug = false) {
    const query = decodeConcertId(req.params.id);
    if (!query) return debug ? { ok: false, streams: [], error: 'invalid concert id' } : { streams: [] };
    const cfg = runtime.unifiedConfig(req);
    const [fa, wa] = await Promise.all([
      fastshareLogin(cfg.fastshare),
      webshareLogin(cfg.webshare)
    ]);
    const [fs, ws] = await Promise.all([
      fa.ok ? searchFastshare(query, fa.hash) : Promise.resolve({ files: [] }),
      wa.ok ? searchWebshare(query, wa.token) : Promise.resolve({ files: [] })
    ]);
    const fastFiles = (fs.files || []).filter(f => titleMatch(f.name, query)).slice(0, 30);
    const webFiles = (ws.files || []).filter(f => titleMatch(f.name, query)).slice(0, 30);
    const [fastStreams, webStreams] = await Promise.all([
      Promise.all(fastFiles.map(async f => directStreamObject(f, 'fastshare', fastshareStreamUrl(f, fa.hash)))),
      mapWithConcurrency(webFiles, 4, async f => {
        const url = await webshareStreamUrl(f, wa.token);
        return url ? directStreamObject(f, 'webshare', url) : null;
      })
    ]);
    const streams = sortCombined([...fastStreams.filter(s => s.url), ...webStreams.filter(Boolean)]);
    if (!debug) return { streams };
    return { ok: true, mode: 'concert-direct-combined', query, streamCount: streams.length, streams };
  }

  async function build(req, debug = false) {
    if (String(req.params.id || '').startsWith('concert:')) return buildConcert(req, debug);
    const [fastshare, webshare] = await Promise.all([
      runtime.buildStreamResponse(req, debug),
      runtime.buildWebshareStreams(req, debug)
    ]);
    const fastStreams = prepare(fastshare?.streams || [], 'fastshare');
    const webStreams = prepare(webshare?.streams || [], 'webshare');
    const streams = sortCombined([...fastStreams, ...webStreams]);
    if (!debug) return { streams };
    return {
      ok: true,
      mode: 'combined-balanced-single-name',
      sort: 'dubbing-desc,size-desc,provider-balanced',
      streamCount: streams.length,
      providers: {
        fastshare: { streamCount: fastStreams.length, auth: fastshare?.auth || null, search: fastshare?.search || null },
        webshare: { streamCount: webStreams.length, auth: webshare?.auth || null, search: webshare?.search || null }
      },
      streams
    };
  }

  async function send(req, res, debug) {
    if (req.params.config) res.set('Cache-Control', 'private, no-store');
    try {
      const payload = await build(req, debug);
      const streams = payload.streams || [];
      console.log('[provider-stream]', JSON.stringify({
        type: req.params.type,
        id: req.params.id,
        mode: payload.mode || 'combined-balanced-single-name',
        count: streams.length,
        fastshare: streams.filter(s => providerOf(s) === 'fastshare').length,
        webshare: streams.filter(s => providerOf(s) === 'webshare').length,
        sort: 'dubbing-desc,size-desc,provider-balanced'
      }));
      res.json(payload);
    } catch (error) {
      if (debug) return res.status(500).json({ ok: false, error: String(error.stack || error) });
      res.json({ streams: [] });
    }
  }

  app.get('/stream/:type/:id.json', (req, res) => send(req, res, false));
  app.get('/:config/stream/:type/:id.json', (req, res) => send(req, res, false));
  app.get('/debug/stream/:type/:id.json', (req, res) => send(req, res, true));
  app.get('/:config/debug/stream/:type/:id.json', (req, res) => send(req, res, true));

  return { ...runtime, buildProviderStreamResponse: build, decodeConcertId };
}

module.exports = installProviderStreamMode;
