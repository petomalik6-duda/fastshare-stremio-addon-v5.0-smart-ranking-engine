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

  function sortBySize(streams) {
    return [...(streams || [])].sort((a, b) => {
      const left = Number(a?.behaviorHints?.videoSize || 0);
      const right = Number(b?.behaviorHints?.videoSize || 0);
      return right - left;
    });
  }

  async function build(req, debug = false) {
    const [fastshare, webshare] = await Promise.all([
      runtime.buildStreamResponse(req, debug),
      runtime.buildWebshareStreams(req, debug)
    ]);

    const fastStreams = sortBySize(fastshare?.streams || []);
    const webStreams = sortBySize(webshare?.streams || []);

    // Never combine providers in one response. FastShare is primary because the
    // original addon is FastShare-first; Webshare is the automatic fallback.
    const provider = fastStreams.length ? 'fastshare' : (webStreams.length ? 'webshare' : 'none');
    const streams = provider === 'fastshare' ? fastStreams : provider === 'webshare' ? webStreams : [];

    if (!debug) return { streams };
    return {
      ok: true,
      provider,
      sort: 'size-desc',
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
        provider: payload.provider || (payload.streams?.[0]?.name || 'none'),
        count: payload.streams?.length || 0,
        sort: 'size-desc'
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
