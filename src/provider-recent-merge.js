'use strict';

const crypto = require('node:crypto');
const { buildCatalog } = require('./catalogs');

const TARGET_IDS = new Set([
  'unified-czsk-movies',
  'unified-czsk-series',
  'unified-latest-movies',
  'unified-latest-series',
  'unified-4k-czsk',
  'unified-search-movies',
  'unified-search-series',
  'unified-search-concerts'
]);

function skipOf(extra) {
  if (!extra) return 0;
  try { return Math.max(0, Number(new URLSearchParams(decodeURIComponent(extra)).get('skip') || 0)); }
  catch { return 0; }
}

function mergeMetas(primary = [], fallback = [], limit = Infinity) {
  const out = [];
  const seen = new Set();
  for (const item of [...primary, ...fallback]) {
    const id = String(item?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

async function buildMerged(runtime, req) {
  const type = req.params.type;
  const id = req.params.id;
  const skip = 0; // Pagination belongs to the final sorted snapshot.
  const config = runtime.unifiedConfig ? runtime.unifiedConfig(req) : {};
  const configKey = crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');

  let recent = null;
  try {
    if (typeof runtime.buildProviderRecentCatalog === 'function') {
      recent = await runtime.buildProviderRecentCatalog(req);
    }
  } catch (error) {
    recent = { metas: [], error: String(error?.message || error), source: 'webshare-recent' };
  }

  let fallback = { metas: [] };
  if (!id.startsWith('unified-search-')) {
    try {
      fallback = await buildCatalog({ type, id, skip, config, configKey, pool: true });
    } catch (error) {
      fallback = { metas: [], error: String(error?.message || error) };
    }
  }

  const recentMetas = Array.isArray(recent?.metas) ? recent.metas : [];
  const fallbackMetas = Array.isArray(fallback?.metas) ? fallback.metas : [];
  const metas = [...recentMetas, ...fallbackMetas];

  return {
    metas,
    diagnostics: {
      id,
      type,
      recentFilesScanned: Number(recent?.filesScanned || 0),
      recentMatched: recentMetas.length,
      fallbackCandidates: Number(fallback?.candidates || 0),
      fallbackMatched: fallbackMetas.length,
      finalCount: metas.length,
      recentError: recent?.error || null,
      fallbackError: fallback?.error || null
    }
  };
}

function install(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  const catalogPaths = new Set([
    '/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'
  ]);
  app._router.stack = app._router.stack.filter(layer => !layer.route || !catalogPaths.has(layer.route.path));

  async function sendCatalog(req, res) {
    if (!TARGET_IDS.has(req.params.id)) return runtime.sendCatalog(req, res);
    try {
      const result = await buildMerged(runtime, req);
      res.set('Cache-Control', 'private, max-age=120');
      console.log('[provider-recent-merge]', JSON.stringify(result.diagnostics));
      return res.json({ metas: result.metas });
    } catch (error) {
      console.error('[provider-recent-merge-error]', String(error?.message || error));
      return runtime.sendCatalog(req, res);
    }
  }

  async function debugCatalog(req, res) {
    res.set('Cache-Control', 'private, no-store');
    if (!TARGET_IDS.has(req.params.id)) return res.status(404).json({ ok: false, error: 'unsupported catalog' });
    try {
      const result = await buildMerged(runtime, req);
      return res.json({ ok: true, ...result.diagnostics, sample: result.metas.slice(0, 10).map(m => ({ id: m.id, name: m.name, releaseInfo: m.releaseInfo })) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  }

  app.get('/catalog/:type/:id.json', sendCatalog);
  app.get('/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/:config/catalog/:type/:id.json', sendCatalog);
  app.get('/:config/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/debug/catalog/:type/:id.json', debugCatalog);
  app.get('/:config/debug/catalog/:type/:id.json', debugCatalog);

  return { ...runtime, sendCatalog, buildMergedCatalog: req => buildMerged(runtime, req) };
}

module.exports = install;
