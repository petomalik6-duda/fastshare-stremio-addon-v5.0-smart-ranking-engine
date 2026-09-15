'use strict';

const { CATALOGS, buildCatalog } = require('./catalogs');
const { VERSION } = require('./config');

function installRuntimeFix(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  const replace = new Set([
    '/manifest.json', '/:config/manifest.json',
    '/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json',
    '/stream/:type/:id.json', '/:config/stream/:type/:id.json'
  ]);
  app._router.stack = app._router.stack.filter(layer => !layer.route || !replace.has(layer.route.path));

  function manifest(configToken = null) {
    return {
      id: 'community.fastshare.webshare.unified.v72',
      version: VERSION,
      name: 'FastShare + Webshare',
      description: 'Unified FastShare + Webshare addon with CZ/SK catalogs and stream search.',
      logo: 'https://www.stremio.com/website/stremio-logo-small.png',
      resources: ['catalog', 'stream'],
      types: ['movie', 'series'],
      catalogs: CATALOGS.map(item => ({
        id: item.id,
        type: item.type,
        name: item.name,
        extra: [{ name: 'skip', isRequired: false }]
      })),
      idPrefixes: ['tt'],
      behaviorHints: { configurable: true, configurationRequired: !configToken }
    };
  }

  function parseSkip(extra) {
    if (!extra) return 0;
    try {
      const params = new URLSearchParams(decodeURIComponent(extra));
      return Math.max(0, Number(params.get('skip') || 0));
    } catch { return 0; }
  }

  async function sendCatalog(req, res) {
    const config = runtime.unifiedConfig(req);
    try {
      const result = await buildCatalog({
        type: req.params.type,
        id: req.params.id,
        skip: parseSkip(req.params.extra),
        config,
        configKey: req.params.config || 'public'
      });
      console.log('[catalog]', JSON.stringify({
        id: req.params.id,
        type: req.params.type,
        count: result?.metas?.length || 0,
        auth: result?.auth || null,
        cache: result?.cache || null
      }));
      res.set('Cache-Control', 'private, max-age=120');
      res.json({ metas: result?.metas || [] });
    } catch (error) {
      console.log('[catalog-error]', String(error?.message || error));
      res.json({ metas: [] });
    }
  }

  async function sendStream(req, res) {
    try {
      const result = await runtime.buildUnifiedResponse(req, true);
      const p = result?.providers || {};
      const summary = {
        type: req.params.type,
        id: req.params.id,
        streams: result?.streams?.length || 0,
        fastshare: {
          streams: p.fastshare?.streamCount || 0,
          authOk: Boolean(p.fastshare?.auth?.ok),
          authError: p.fastshare?.auth?.error || null,
          primaryCounts: (p.fastshare?.search?.primary || []).map(x => x.resultCount || 0),
          fallbackCounts: (p.fastshare?.search?.fallback || []).map(x => x.resultCount || 0)
        },
        webshare: {
          streams: p.webshare?.streamCount || 0,
          authOk: Boolean(p.webshare?.auth?.ok),
          authError: p.webshare?.auth?.error || null,
          primaryCounts: (p.webshare?.search?.primary || []).map(x => x.resultCount || 0),
          fallbackCounts: (p.webshare?.search?.fallback || []).map(x => x.resultCount || 0)
        }
      };
      console.log('[stream-diag]', JSON.stringify(summary));
      res.set('Cache-Control', 'private, no-store');
      res.json({ streams: result?.streams || [] });
    } catch (error) {
      console.log('[stream-error]', String(error?.stack || error));
      res.json({ streams: [] });
    }
  }

  app.get('/manifest.json', (req, res) => res.json(manifest(null)));
  app.get('/:config/manifest.json', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(manifest(req.params.config));
  });

  app.get('/catalog/:type/:id.json', sendCatalog);
  app.get('/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/:config/catalog/:type/:id.json', sendCatalog);
  app.get('/:config/catalog/:type/:id/:extra.json', sendCatalog);

  app.get('/stream/:type/:id.json', sendStream);
  app.get('/:config/stream/:type/:id.json', sendStream);

  runtime.manifest = manifest;
  return runtime;
}

module.exports = installRuntimeFix;
