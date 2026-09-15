'use strict';

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
    const text = `${stream?.name || ''} ${stream?.title || ''}`.toLowerCase();
    return text.includes('webshare') ? 'webshare' : 'fastshare';
  }

  function labelProvider(stream, provider) {
    const tag = provider === 'webshare' ? 'Webshare' : 'FastShare';
    const title = String(stream?.title || '');
    const taggedTitle = title.startsWith(`[${tag}]`) ? title : `[${tag}] ${title}`;
    return {
      ...stream,
      name: `${tag}${String(stream?.name || '').replace(/^(FastShare|Webshare)/i, '')}`,
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
      const f = fast[0];
      const w = web[0];
      let pick;
      if (!f) pick = 'webshare';
      else if (!w) pick = 'fastshare';
      else {
        const natural = streamSize(f) >= streamSize(w) ? 'fastshare' : 'webshare';
        const other = natural === 'fastshare' ? 'webshare' : 'fastshare';
        pick = streakProvider === natural && streak >= 3 ? other : natural;
      }

      const chosen = pick === 'fastshare' ? fast.shift() : web.shift();
      if (!chosen) continue;
      out.push(chosen);
      if (streakProvider === pick) streak++;
      else { streakProvider = pick; streak = 1; }
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
    for (const rank of [4, 3, 2, 1, 0]) {
      if (groups.has(rank)) out.push(...balancedGroup(groups.get(rank)));
    }
    return out;
  }

  async function build(req, debug = false) {
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
      mode: 'combined-balanced',
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
        mode: 'combined-balanced',
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

  return { ...runtime, buildProviderStreamResponse: build };
}

module.exports = installProviderStreamMode;
