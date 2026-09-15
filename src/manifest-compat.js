'use strict';

const { CATALOGS, preferredLocalizedTitle } = require('./catalogs');

function installManifestCompat(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  const paths = new Set([
    '/manifest.json', '/:config/manifest.json',
    '/meta/:type/:id.json', '/:config/meta/:type/:id.json'
  ]);
  app._router.stack = app._router.stack.filter(layer => !layer.route || !paths.has(layer.route.path));

  function manifest(configToken = null) {
    return {
      id: 'community.fastshare.webshare.unified.v713',
      version: '7.13.0',
      name: 'FastShare + Webshare',
      description: 'Unified FastShare/Webshare streams with Czech-first, Slovak-second localized movie and series titles plus reference concert metadata matching.',
      logo: 'https://www.stremio.com/website/stremio-logo-small.png',
      resources: ['catalog', 'meta', 'stream'],
      types: ['movie', 'series'],
      catalogs: CATALOGS.map(item => ({
        id: item.id,
        type: item.type,
        name: item.name,
        extra: [{ name: 'skip', isRequired: false }]
      })),
      idPrefixes: ['tt', 'concert'],
      behaviorHints: {
        configurable: true,
        configurationRequired: !configToken
      }
    };
  }

  app.get('/manifest.json', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(manifest(null));
  });

  app.get('/:config/manifest.json', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(manifest(req.params.config));
  });

  async function sendMeta(req, res) {
    try {
      const data = await runtime.getMeta(req.params.type, req.params.id);
      const raw = data?.raw || {};
      const meta = {
        ...raw,
        id: raw.id || data.imdbId || req.params.id,
        type: req.params.type,
        name: preferredLocalizedTitle(data, raw.name || raw.title || data.title || data.imdbId || req.params.id)
      };
      res.set('Cache-Control', 'public, max-age=900');
      res.json({ meta });
    } catch (error) {
      res.status(404).json({ meta: null });
    }
  }

  app.get('/meta/:type/:id.json', sendMeta);
  app.get('/:config/meta/:type/:id.json', sendMeta);

  return { ...runtime, manifest };
}

module.exports = installManifestCompat;
