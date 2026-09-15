'use strict';

const { mapWithConcurrency } = require('./utils');
const { wikipediaMetadata } = require('./concert-wikipedia-fallback');

function install(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack || !runtime.discoverConcerts || !runtime.enrichConcert) return runtime;

  const catalogPaths = new Set([
    '/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'
  ]);
  const metaPaths = new Set(['/meta/:type/:id.json', '/:config/meta/:type/:id.json']);
  app._router.stack = app._router.stack.filter(layer => !layer.route || (!catalogPaths.has(layer.route.path) && !metaPaths.has(layer.route.path)));

  function skipOf(extra) {
    if (!extra) return 0;
    try { return Math.max(0, Number(new URLSearchParams(decodeURIComponent(extra)).get('skip') || 0)); }
    catch { return 0; }
  }

  function needsFallback(meta) {
    if (!meta) return true;
    const description = String(meta.description || '');
    const hasUsefulDescription = Boolean(description) && !/^Koncert nájdený priamo/i.test(description) && !/^Živý koncert\b/i.test(description);
    const hasVisual = Boolean(meta.poster || meta.background);
    return !hasUsefulDescription || !hasVisual;
  }

  async function enrichWithFallback(item) {
    const base = await runtime.enrichConcert(item);
    if (!needsFallback(base)) return base;
    try {
      const wiki = await wikipediaMetadata(item.title || base?.name || '');
      if (!wiki) return base;
      return {
        ...base,
        name: base?.name || wiki.name || item.title,
        description: (!base?.description || /^Koncert nájdený priamo/i.test(base.description) || /^Živý koncert\b/i.test(base.description))
          ? (wiki.description || base?.description)
          : base.description,
        poster: base?.poster || wiki.poster,
        background: base?.background || wiki.background || wiki.poster,
        links: [...(base?.links || []), ...(wiki.links || [])],
        metadataSource: [base?.metadataSource, wiki.source].filter(Boolean).join('+') || wiki.source
      };
    } catch {
      return base;
    }
  }

  async function sendCatalog(req, res) {
    if (req.params.id !== 'unified-concerts' || req.params.type !== 'movie') return runtime.sendCatalog(req, res);
    try {
      const all = await runtime.discoverConcerts(runtime, req);
      const skip = skipOf(req.params.extra);
      const page = all.slice(skip, skip + 40);
      const enriched = await mapWithConcurrency(page, 4, enrichWithFallback);
      const metas = enriched.map(item => ({
        id: runtime.encodeConcertId(item.title),
        type: 'movie',
        name: item.name || item.title,
        poster: item.poster,
        background: item.background,
        description: item.description,
        releaseInfo: item.releaseInfo,
        imdbRating: item.imdbRating,
        genres: item.genres,
        runtime: item.runtime,
        links: item.links,
        behaviorHints: { defaultVideoId: runtime.encodeConcertId(item.title) }
      }));
      res.set('Cache-Control', 'private, max-age=300');
      console.log('[concert-metadata-overlay]', JSON.stringify({
        total: all.length,
        skip,
        count: metas.length,
        withPoster: metas.filter(m => m.poster).length,
        withDescription: metas.filter(m => m.description && !/^Koncert nájdený priamo/i.test(m.description)).length
      }));
      res.json({ metas });
    } catch (error) {
      console.error('[concert-overlay-error]', String(error?.message || error));
      res.json({ metas: [] });
    }
  }

  async function sendMeta(req, res) {
    const title = runtime.decodeConcertId(req.params.id);
    if (title) {
      const meta = await enrichWithFallback({ title, filename: title, provider: 'FastShare/Webshare', size: 0 });
      return res.json({ meta: {
        id: req.params.id,
        type: 'movie',
        name: meta.name || title,
        poster: meta.poster,
        background: meta.background,
        releaseInfo: meta.releaseInfo,
        description: meta.description,
        imdbRating: meta.imdbRating,
        genres: meta.genres,
        runtime: meta.runtime,
        links: meta.links
      }});
    }
    try {
      const data = await runtime.getMeta(req.params.type, req.params.id);
      const raw = data?.raw || {};
      res.json({ meta: {
        ...raw,
        id: raw.id || data.imdbId || req.params.id,
        type: raw.type || req.params.type,
        name: raw.name || raw.title || data.title || req.params.id
      }});
    } catch {
      res.status(404).json({ meta: null });
    }
  }

  app.get('/catalog/:type/:id.json', sendCatalog);
  app.get('/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/:config/catalog/:type/:id.json', sendCatalog);
  app.get('/:config/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/meta/:type/:id.json', sendMeta);
  app.get('/:config/meta/:type/:id.json', sendMeta);

  return {
    ...runtime,
    enrichConcertWithFallback: enrichWithFallback,
    enrichConcertWithWikipedia: enrichWithFallback
  };
}

module.exports = install;
