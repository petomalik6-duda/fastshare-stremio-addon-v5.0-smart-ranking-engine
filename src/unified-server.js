'use strict';

const runtime = require('./server');
const { VERSION, MAX_STREAMS, PRIMARY_MATCH_TARGET, SEARCH_CONCURRENCY } = require('./config');
const { mapWithConcurrency, bytesToHuman } = require('./utils');
const { login: webshareLogin, searchWebshare, streamUrl: webshareStreamUrl } = require('./webshare');

const app = runtime.app;

function decodeConfig(value) {
  try { return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8')); }
  catch { return {}; }
}

function encodeConfig(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function unifiedConfig(req) {
  const cfg = req.params.config ? decodeConfig(req.params.config) : {};
  return {
    fastshare: {
      username: cfg.username || cfg.fastshareUsername || process.env.FASTSHARE_USERNAME || '',
      password: cfg.password || cfg.fastsharePassword || process.env.FASTSHARE_PASSWORD || ''
    },
    webshare: {
      username: cfg.webshareUsername || process.env.WEBSHARE_USERNAME || '',
      password: cfg.websharePassword || process.env.WEBSHARE_PASSWORD || ''
    }
  };
}

function manifest(configToken = null) {
  return {
    id: 'community.fastshare.webshare.unified.v7',
    version: VERSION,
    name: 'FastShare + Webshare',
    description: 'Unified FastShare and Webshare stream addon with shared metadata matching and ranking.',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', ''] }],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true, configurationRequired: !configToken },
    config: [
      { key: 'username', type: 'text', title: 'FastShare username' },
      { key: 'password', type: 'password', title: 'FastShare password' },
      { key: 'webshareUsername', type: 'text', title: 'Webshare username / email' },
      { key: 'websharePassword', type: 'password', title: 'Webshare password' }
    ]
  };
}

function publicBaseUrl(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwarded || req.protocol || 'https';
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}

function removeRoutes(paths) {
  const wanted = new Set(paths);
  if (!app?._router?.stack) return;
  app._router.stack = app._router.stack.filter(layer => !layer.route || !wanted.has(layer.route.path));
}

removeRoutes([
  '/', '/health', '/manifest.json', '/:config/manifest.json', '/configure',
  '/stream/:type/:id.json', '/:config/stream/:type/:id.json',
  '/debug/stream/:type/:id.json', '/:config/debug/stream/:type/:id.json',
  '/debug/login', '/:config/debug/login', '/debug/search', '/:config/debug/search'
]);

function compactSearch(result) {
  return {
    term: result?.term || '',
    status: Number(result?.status || 0),
    resultCount: Number(result?.resultCount || 0),
    cache: result?.cache || 'miss',
    ...(result?.error ? { error: result.error } : {})
  };
}

async function runWebshareTerms(terms, token) {
  if (!terms.length || !token) return [];
  return mapWithConcurrency(terms, SEARCH_CONCURRENCY, term => searchWebshare(term, token));
}

function filesFrom(searches) {
  return searches.flatMap(result => Array.isArray(result?.files) ? result.files : []);
}

async function buildWebshareStreams(req, debug = false) {
  const cfg = unifiedConfig(req);
  const auth = await webshareLogin(cfg.webshare);
  const type = req.params.type;
  const id = req.params.id;
  if (!auth.ok) {
    return debug ? { auth, streams: [], files: [], search: { primary: [], fallback: [] } } : { streams: [] };
  }

  const meta = await runtime.getMeta(type, id);
  const plan = runtime.searchTermPlan(meta);
  const primary = await runWebshareTerms(plan.primary, auth.token);
  let ranked = runtime.rankFiles(filesFrom(primary), meta, type);
  let fallback = [];
  let usedFallback = false;
  if (ranked.length < PRIMARY_MATCH_TARGET && plan.fallback.length) {
    usedFallback = true;
    fallback = await runWebshareTerms(plan.fallback, auth.token);
    ranked = runtime.rankFiles([...filesFrom(primary), ...filesFrom(fallback)], meta, type);
  }

  const limit = Math.min(Math.max(8, Math.ceil(MAX_STREAMS / 2)), 24);
  const candidates = ranked.slice(0, limit);
  const resolved = await mapWithConcurrency(candidates, 4, async file => ({ file, url: await webshareStreamUrl(file, auth.token) }));
  const playable = resolved.filter(item => item?.url);
  const streams = playable.map(({ file, url }, index) => {
    const size = bytesToHuman(file.size);
    const bits = [file.quality, size, file.ext].filter(Boolean).join(' • ');
    const lang = [file.audio?.label, ...(file.audio?.subs || [])].filter(Boolean).join(' • ');
    const badges = runtime.detectBadgeTags(file.name, file);
    const firstLine = [index === 0 ? '⭐ Webshare' : 'Webshare', ...badges].filter(Boolean).join(' • ');
    return {
      name: `Webshare${file.audio?.key && file.audio.key !== 'any' ? ' ' + file.audio.key.replace('-', '/') : ''}`,
      title: `${firstLine}\n${file.name}\n${bits}\n${lang}`,
      url,
      behaviorHints: {
        bingeGroup: `webshare-${file.quality || 'auto'}-${file.audio?.key || 'any'}`,
        filename: file.name,
        videoSize: Number(file.size || 0) || undefined
      }
    };
  });

  if (!debug) return { streams };
  return {
    auth: { ok: true, source: auth.source, hasToken: true },
    meta,
    plan: { ...plan, usedFallback },
    search: { primary: primary.map(compactSearch), fallback: fallback.map(compactSearch) },
    files: candidates,
    streams
  };
}

function interleave(a, b, limit) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < limit; i++) {
    if (a[i]) out.push(a[i]);
    if (b[i] && out.length < limit) out.push(b[i]);
  }
  return out;
}

async function buildUnifiedResponse(req, debug = false) {
  const [fastshare, webshare] = await Promise.all([
    runtime.buildStreamResponse(req, debug),
    buildWebshareStreams(req, debug)
  ]);
  const fastStreams = fastshare?.streams || [];
  const webStreams = webshare?.streams || [];
  const streams = interleave(fastStreams, webStreams, MAX_STREAMS);
  if (!debug) return { streams };
  return {
    ok: true,
    version: VERSION,
    providers: {
      fastshare: { streamCount: fastStreams.length, auth: fastshare?.auth || null, search: fastshare?.search || null },
      webshare: { streamCount: webStreams.length, auth: webshare?.auth || null, search: webshare?.search || null }
    },
    streamCount: streams.length,
    streams
  };
}

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/health', (req, res) => res.json({
  ok: true,
  version: VERSION,
  addon: 'FastShare + Webshare',
  providers: ['fastshare', 'webshare'],
  architecture: 'unified-v7',
  searchMode: 'parallel-two-stage'
}));

app.get('/manifest.json', (req, res) => res.json(manifest(null)));
app.get('/:config/manifest.json', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(manifest(req.params.config));
});

app.get('/configure', (req, res) => {
  const base = publicBaseUrl(req);
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FastShare + Webshare</title><style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#111;color:#eee}input,button{font-size:16px;padding:12px;border-radius:8px;border:1px solid #444;background:#222;color:#fff;width:100%;box-sizing:border-box;margin:8px 0}button{background:#1976d2;cursor:pointer}.box{background:#1b1b1b;padding:18px;border-radius:12px;margin:12px 0}.warn{color:#ffd166}.ok{color:#8ee59b}textarea{width:100%;min-height:92px;background:#0b0b0b;color:#9cdcfe;border:1px solid #444;border-radius:8px;padding:10px;box-sizing:border-box}a{color:#8ab4ff}</style></head><body><h1>FastShare + Webshare v${VERSION}</h1><div class="box"><h2>FastShare</h2><input id="fsu" placeholder="FastShare username"><input id="fsp" type="password" placeholder="FastShare password"><h2>Webshare</h2><input id="wsu" placeholder="Webshare username alebo e-mail"><input id="wsp" type="password" placeholder="Webshare password"><button id="go">Vygenerovať addon URL</button><p>Stačí vyplniť aspoň jednu službu; pri vyplnení oboch addon hľadá paralelne na FastShare aj Webshare.</p><p class="warn">Vygenerovanú URL nezdieľaj. Obsahuje zakódované prihlasovacie údaje.</p><div id="out"></div></div><script>(function(){var BASE=${JSON.stringify(base)};function enc(s){var b=new TextEncoder().encode(s),x='';for(var i=0;i<b.length;i++)x+=String.fromCharCode(b[i]);return btoa(x).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}function h(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}document.getElementById('go').onclick=function(){var cfg={username:document.getElementById('fsu').value.trim(),password:document.getElementById('fsp').value,webshareUsername:document.getElementById('wsu').value.trim(),websharePassword:document.getElementById('wsp').value};if(!(cfg.username&&cfg.password)&&!(cfg.webshareUsername&&cfg.websharePassword)){document.getElementById('out').innerHTML='<p class="warn">Vyplň kompletné prihlásenie aspoň pre jednu službu.</p>';return}var token=enc(JSON.stringify(cfg));var url=BASE+'/'+token+'/manifest.json';var st='stremio://'+url.replace(/^https?:\/\//,'');document.getElementById('out').innerHTML='<p class="ok"><b>Addon URL je pripravená.</b></p><textarea readonly onclick="this.select()">'+h(url)+'</textarea><p><a href="'+h(st)+'">Install do Stremia</a></p><p><a target="_blank" href="'+h(url)+'">Otvoriť manifest</a></p>'}})();</script></body></html>`);
});

app.post('/configure', (req, res) => {
  const token = encodeConfig({
    username: req.body.username || '', password: req.body.password || '',
    webshareUsername: req.body.webshareUsername || '', websharePassword: req.body.websharePassword || ''
  });
  res.redirect(`/${token}/manifest.json`);
});

app.get('/stream/:type/:id.json', async (req, res) => {
  try { res.json(await buildUnifiedResponse(req, false)); } catch { res.json({ streams: [] }); }
});
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json(await buildUnifiedResponse(req, false)); } catch { res.json({ streams: [] }); }
});
app.get('/debug/stream/:type/:id.json', async (req, res) => {
  try { res.json(await buildUnifiedResponse(req, true)); } catch (error) { res.status(500).json({ ok: false, version: VERSION, error: String(error.stack || error) }); }
});
app.get('/:config/debug/stream/:type/:id.json', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json(await buildUnifiedResponse(req, true)); } catch (error) { res.status(500).json({ ok: false, version: VERSION, error: String(error.stack || error) }); }
});

app.get('/:config/debug/webshare-login', async (req, res) => {
  const auth = await webshareLogin(unifiedConfig(req).webshare);
  res.set('Cache-Control', 'private, no-store');
  res.json({ ok: auth.ok, version: VERSION, auth: auth.ok ? { ok: true, source: auth.source, hasToken: true } : auth });
});
app.get('/:config/debug/webshare-search', async (req, res) => {
  const auth = await webshareLogin(unifiedConfig(req).webshare);
  if (!auth.ok) return res.json({ ok: false, auth, files: [] });
  const result = await searchWebshare(req.query.term || 'avatar', auth.token);
  res.set('Cache-Control', 'private, no-store');
  res.json({ ok: true, version: VERSION, auth: { ok: true, source: auth.source }, ...result });
});

module.exports = { ...runtime, app, manifest, unifiedConfig, buildUnifiedResponse, buildWebshareStreams };
