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
    const text = `${stream?.name || ''} ${stream?.title || ''}`.toLowerCase();
    // Highest confidence: explicit bilingual or explicit CZ/SK dubbing labels.
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

  function providerRank(stream) {
    const name = String(stream?.name || '').toLowerCase();
    if (name.includes('fastshare')) return 1;
    if (name.includes('webshare')) return 0;
    return 0;
  }

  function sortCombined(streams) {
    return [...(streams || [])].sort((a, b) => {
      const dubDiff = dubbingRank(b) - dubbingRank(a);
      if (dubDiff) return dubDiff;
      const sizeDiff = streamSize(b) - streamSize(a);
      if (sizeDiff) return sizeDiff;
      return providerRank(b) - providerRank(a);
    });
  }

  async function build(req, debug = false) {
    const [fastshare, webshare] = await Promise.all([
      runtime.buildStreamResponse(req, debug),
      runtime.buildWebshareStreams(req, debug)
    ]);

    const fastStreams = fastshare?.streams || [];
    const webStreams = webshare?.streams || [];
    const streams = sortCombined([...fastStreams, ...webStreams]);

    if (!debug) return { streams };
    return {
      ok: true,
      mode: 'combined',
      sort: 'dubbing-desc,size-desc',
      streamCount: streams.length,
      providers: {
        fastshare: {
          streamCount: fastStreams.length,
          auth: fastshare?.auth || null,
          search: fastshare?.search || null
        },
        webshare: {
          streamCount: webStreams.length,
          auth: webshare?.auth || null,
          search: webshare?.search || null
        }
      },
      streams
    };
  }

  async function send(req, res, debug) {
    if (req.params.config) res.set('Cache-Control', 'private, no-store');
    try {
      const payload = await build(req, debug);
      console.log('[provider-stream]', JSON.stringify({
        type: req.params.type,
        id: req.params.id,
        mode: 'combined',
        count: payload.streams?.length || 0,
        sort: 'dubbing-desc,size-desc'
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
