'use strict';

const { login: fastshareLogin, searchFastshare } = require('./fastshare');
const { login: webshareLogin, searchWebshare } = require('./webshare');
const { mapWithConcurrency, normalize } = require('./utils');

const TERMS = ['concert', 'live concert', 'world tour', 'unplugged', 'festival', 'live at', 'live in'];
const CONCERT_RX = /\b(concert|live\s+(at|in|from)|world\s+tour|tour\s+live|unplugged|festival|live\s+concert|live\s+performance)\b/i;
const VIDEO_RX = /\.(mkv|mp4|avi|mov|m4v)(?:$|[?\s])/i;
const cache = new Map();
const TTL = 10 * 60 * 1000;

function encodeConcertId(title) {
  return `concert:${Buffer.from(String(title || '').slice(0, 180), 'utf8').toString('base64url')}`;
}

function decodeConcertId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('concert:')) return '';
  try { return Buffer.from(raw.slice(8), 'base64url').toString('utf8'); } catch { return ''; }
}

function cleanConcertTitle(filename) {
  let s = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, ' ');
  s = s.replace(/[._]+/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|dv|dolby|web[- ]?dl|webrip|bluray|brrip|remux|x264|x265|h264|h265|hevc|aac|ac3|eac3|ddp|dts|truehd|atmos|flac|mp3)\b/ig, ' ')
    .replace(/\b(cz|cze|cs|sk|svk|eng|en)\s*(dab|dub|dabing|audio|subs?|tit|titulky)?\b/ig, ' ')
    .replace(/\[[^\]]+\]|\([^\)]*(?:rip|codec|audio|subs?|gb)[^\)]*\)/ig, ' ')
    .replace(/\s+/g, ' ').trim();
  return s.slice(0, 150);
}

function isConcertFile(file) {
  const name = String(file?.name || '');
  if (!CONCERT_RX.test(name)) return false;
  if (file?.ext) return true;
  return VIDEO_RX.test(name) || Number(file?.size || 0) > 200 * 1024 * 1024;
}

function getCached(key) {
  const item = cache.get(key);
  if (!item || Date.now() - item.at > TTL) return null;
  return item.value;
}
function setCached(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
}

async function discover(runtime, req) {
  const cfg = runtime.unifiedConfig(req);
  const cacheKey = `${cfg.fastshare.username || ''}|${cfg.webshare.username || ''}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const [fa, wa] = await Promise.all([
    fastshareLogin(cfg.fastshare),
    webshareLogin(cfg.webshare)
  ]);

  const [fr, wr] = await Promise.all([
    fa.ok ? mapWithConcurrency(TERMS, 3, term => searchFastshare(term, fa.hash)) : [],
    wa.ok ? mapWithConcurrency(TERMS, 3, term => searchWebshare(term, wa.token)) : []
  ]);

  const rows = [
    ...(fr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'FastShare' }))),
    ...(wr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'Webshare' })))
  ].filter(isConcertFile);

  const byTitle = new Map();
  for (const file of rows) {
    const title = cleanConcertTitle(file.name);
    const key = normalize(title)
      .replace(/\b(19\d{2}|20\d{2})\b/g, '')
      .replace(/\s+/g, ' ').trim();
    if (!title || key.length < 5) continue;
    const prev = byTitle.get(key);
    const size = Number(file.size || 0);
    if (!prev || size > prev.size) byTitle.set(key, { title, size, provider: file.provider, filename: file.name });
  }

  const value = [...byTitle.values()]
    .sort((a, b) => b.size - a.size || a.title.localeCompare(b.title))
    .slice(0, 300);
  setCached(cacheKey, value);
  return value;
}

function install(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

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

  async function sendCatalog(req, res) {
    if (req.params.id !== 'unified-concerts' || req.params.type !== 'movie') return runtime.sendCatalog(req, res);
    try {
      const all = await discover(runtime, req);
      const skip = skipOf(req.params.extra);
      const page = all.slice(skip, skip + 40);
      const metas = page.map(item => ({
        id: encodeConcertId(item.title),
        type: 'movie',
        name: item.title,
        description: `Koncert nájdený priamo na ${item.provider}. ${item.filename}`,
        releaseInfo: String(item.title.match(/\b(19\d{2}|20\d{2})\b/)?.[0] || ''),
        behaviorHints: { defaultVideoId: encodeConcertId(item.title) }
      }));
      res.set('Cache-Control', 'private, max-age=300');
      console.log('[concert-catalog-direct]', JSON.stringify({ total: all.length, skip, count: metas.length }));
      res.json({ metas });
    } catch (error) {
      console.error('[concert-catalog-error]', String(error?.message || error));
      res.json({ metas: [] });
    }
  }

  async function sendMeta(req, res) {
    const title = decodeConcertId(req.params.id);
    if (title) {
      const year = title.match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '';
      return res.json({ meta: {
        id: req.params.id,
        type: 'movie',
        name: title,
        releaseInfo: year,
        description: 'Koncert nájdený priamo vo FastShare/Webshare katalógu.'
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

  return { ...runtime, encodeConcertId, decodeConcertId, discoverConcerts: discover };
}

module.exports = install;
