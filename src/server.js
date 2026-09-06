'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const {
  VERSION,
  PORT,
  BASE_URL,
  MAX_STREAMS,
  PRIMARY_MATCH_TARGET,
  SEARCH_CONCURRENCY,
  FASTSHARE_SEARCH_CACHE_TTL_MS
} = require('./config');
const { bytesToHuman, mapWithConcurrency } = require('./utils');
const {
  getTitleAliases,
  detectAudio,
  rankFiles,
  searchTermPlan,
  termsFor
} = require('./ranking');
const {
  getMeta,
  getLocalizedTitleData,
  extractTmdbLocalizedAliases,
  extractWikidataLocalizedAliases
} = require('./metadata');
const { login, searchFastshare, streamUrl } = require('./fastshare');
const {
  detectBadgeTags,
  buildExtraNuvioFilters,
  adaptNardBadgeFilters,
  getBaseNuvioBadgePreset,
  mergeNuvioBadgeFilters,
  NARD_BADGES_URL
} = require('./badges');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/badges', express.static(path.join(__dirname, '..', 'public', 'badges'), { maxAge: '30d' }));

function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function b64urlDecode(value) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function getCredentials(req) {
  const token = req.params.config;
  const cfg = token ? b64urlDecode(token) : {};
  return {
    username: cfg.username || process.env.FASTSHARE_USERNAME || '',
    password: cfg.password || process.env.FASTSHARE_PASSWORD || '',
    token: token || null
  };
}

function manifest(configToken = null) {
  return {
    id: 'community.fastshare.kodiapi.configurator.v6',
    version: VERSION,
    name: 'FastShare Kodi API',
    description: 'FastShare streams using FastShare Kodi API. Configure with your own lawful account.',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', ''] }],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true, configurationRequired: !configToken },
    config: [
      { key: 'username', type: 'text', title: 'FastShare username' },
      { key: 'password', type: 'password', title: 'FastShare password' }
    ]
  };
}

function publicBaseUrl(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwarded || req.protocol || 'https';
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (host) return `${protocol}://${host}`;
  return BASE_URL;
}

function streamObj(file, hash, recommended) {
  const size = bytesToHuman(file.size);
  const bits = [file.quality, size, file.ext, file.durationText].filter(Boolean).join(' • ');
  const lang = [file.audio.label, ...(file.audio.subs || [])].filter(Boolean).join(' • ');
  const badgeTags = detectBadgeTags(file.name, file);
  const firstLine = [recommended ? '⭐ Odporúčané' : '', ...badgeTags].filter(Boolean).join(' • ') || 'FastShare';
  const title = `${firstLine}\n${file.name}\n${bits}\n${lang}`;
  return {
    name: `FastShare${file.audio.key !== 'any' ? ' ' + file.audio.key.replace('-', '/') : ''}`,
    title,
    url: streamUrl(file, hash),
    behaviorHints: {
      bingeGroup: `fastshare-${file.quality || 'auto'}-${file.audio.key}`,
      filename: file.name,
      videoSize: Number(file.size || 0) || undefined
    }
  };
}

function compactSearchResult(result) {
  return {
    term: result?.term || result?.item || '',
    status: Number(result?.status || 0),
    resultCount: Number(result?.resultCount || 0),
    cache: result?.cache || 'miss',
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.timedOut ? { timedOut: true } : {}),
    firstFiles: Array.isArray(result?.files) ? result.files.slice(0, 3) : []
  };
}

async function runSearchTerms(terms, hash) {
  if (!terms.length) return [];
  const results = await mapWithConcurrency(
    terms,
    SEARCH_CONCURRENCY,
    term => searchFastshare(term, hash)
  );
  return results.map((result, index) => {
    if (result && Array.isArray(result.files)) return result;
    return {
      term: terms[index],
      status: 0,
      resultCount: 0,
      files: [],
      cache: 'miss',
      error: result?.error || 'search worker failed'
    };
  });
}

function filesFromSearches(searches) {
  return searches.flatMap(result => Array.isArray(result?.files) ? result.files : []);
}

async function buildStreamResponse(req, debug = false) {
  const creds = getCredentials(req);
  const auth = await login(creds);
  const type = req.params.type;
  const id = req.params.id;
  if (!auth.ok) {
    return debug
      ? { ok: true, version: VERSION, auth, request: { type, id }, streams: [] }
      : { streams: [] };
  }

  const meta = await getMeta(type, id);
  const plan = searchTermPlan(meta);

  const primarySearches = await runSearchTerms(plan.primary, auth.hash);
  let ranked = rankFiles(filesFromSearches(primarySearches), meta, type);
  let fallbackSearches = [];
  let usedFallback = false;

  // v6.4 two-stage search: broad queries are only issued if the high-confidence
  // localized/title/year queries did not already produce enough usable streams.
  if (ranked.length < PRIMARY_MATCH_TARGET && plan.fallback.length) {
    usedFallback = true;
    fallbackSearches = await runSearchTerms(plan.fallback, auth.hash);
    ranked = rankFiles(
      [...filesFromSearches(primarySearches), ...filesFromSearches(fallbackSearches)],
      meta,
      type
    );
  }

  const sorted = ranked.slice(0, MAX_STREAMS);
  const streams = sorted.map((file, index) => streamObj(file, auth.hash, index === 0));
  if (!debug) return { streams };

  return {
    ok: true,
    version: VERSION,
    request: { type, id },
    meta,
    aliases: getTitleAliases(meta),
    terms: termsFor(meta),
    searchPlan: {
      primary: plan.primary,
      fallback: plan.fallback,
      primaryMatchTarget: PRIMARY_MATCH_TARGET,
      usedFallback
    },
    auth: { ok: true, source: auth.source, hasHash: true },
    search: {
      primary: primarySearches.map(compactSearchResult),
      fallback: fallbackSearches.map(compactSearchResult)
    },
    streamCount: streams.length,
    files: sorted,
    streams
  };
}

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/health', (req, res) => res.json({
  ok: true,
  version: VERSION,
  architecture: 'modular-v6.4',
  searchMode: 'two-stage',
  searchCacheTtlMs: FASTSHARE_SEARCH_CACHE_TTL_MS,
  badgeDesign: 'NardBadges'
}));

app.get('/nuvio-badges-extra.json', (req, res) => {
  res.set('X-Nuvio-Badge-Design', 'NardBadges-compatible');
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ filters: buildExtraNuvioFilters(publicBaseUrl(req)) });
});

async function sendNardBadgePreset(req, res) {
  const extra = buildExtraNuvioFilters(publicBaseUrl(req));
  try {
    const base = await getBaseNuvioBadgePreset();
    res.set('X-Nuvio-Base-Preset', base.fastsharePresetSource || 'nard');
    res.set('X-Nuvio-Badge-Design', 'NardBadges');
    res.set('Cache-Control', 'public, max-age=3600');
    const { fastsharePresetSource, ...payload } = base;
    res.json({ ...payload, filters: mergeNuvioBadgeFilters(base.filters, extra) });
  } catch {
    res.set('X-Nuvio-Base-Preset', 'local-fallback');
    res.set('X-Nuvio-Badge-Design', 'NardBadges-compatible');
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ filters: extra });
  }
}

app.get('/nuvio-badges.json', sendNardBadgePreset);
app.get('/nuvio-nard-badges.json', sendNardBadgePreset);

app.get('/manifest.json', (req, res) => res.json(manifest(null)));
app.get('/:config/manifest.json', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(manifest(req.params.config));
});

app.get('/configure', (req, res) => {
  const origin = publicBaseUrl(req);
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FastShare Stremio Configurator</title>
<style>
body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
input,button{font-size:16px;padding:12px;border-radius:8px;border:1px solid #444;background:#222;color:#fff;width:100%;box-sizing:border-box;margin:8px 0}
button{background:#1976d2;cursor:pointer}.box{background:#1b1b1b;padding:18px;border-radius:12px;margin:12px 0}
code,textarea{word-break:break-all;color:#9cdcfe;background:#0b0b0b}.warn{color:#ffd166}.ok{color:#8ee59b}
a{color:#8ab4ff} textarea{width:100%;min-height:92px;border:1px solid #444;border-radius:8px;padding:10px;box-sizing:border-box}
</style></head>
<body>
<h1>FastShare Stremio Addon v${VERSION}</h1>
<div class="box">
<p>Zadaj FastShare prihlasenie. Údaje sa uložia iba do vygenerovanej manifest URL.</p>
<input id="fsUser" name="username" placeholder="FastShare username" autocomplete="username">
<input id="fsPass" name="password" placeholder="FastShare password" type="password" autocomplete="current-password">
<button type="button" id="genBtn">Vygenerovať URL</button>
<p class="warn">URL neposielaj verejne, obsahuje zakódované prihlasovanie.</p>
<div id="out"><p>Zatiaľ nie je vygenerovaná žiadna URL.</p></div>
</div>
<div class="box">
<p><b>Fallback bez JavaScriptu:</b> keď tlačidlo nefunguje, použi toto tlačidlo.</p>
<form method="post" action="/configure">
<input name="username" placeholder="FastShare username">
<input name="password" placeholder="FastShare password" type="password">
<button type="submit">Otvoriť manifest bez JS</button>
</form>
</div>
<script>
(function(){
  var BASE = ${JSON.stringify(origin)};
  function encUtf8ToB64Url(str){
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function html(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function generate(){
    var u = document.getElementById('fsUser').value.trim();
    var p = document.getElementById('fsPass').value;
    var out = document.getElementById('out');
    if(!u || !p){ out.innerHTML = '<p class="warn">Vyplň username aj password.</p>'; return; }
    var token = encUtf8ToB64Url(JSON.stringify({username:u,password:p}));
    var manifestUrl = BASE + '/' + token + '/manifest.json';
    var stremioUrl = 'stremio://' + manifestUrl.replace(/^https?:\/\//,'');
    out.innerHTML = '<p class="ok"><b>URL vygenerovaná.</b></p>'+
      '<p><b>Manifest URL:</b></p><textarea readonly onclick="this.select()">'+html(manifestUrl)+'</textarea>'+
      '<p><a href="'+html(stremioUrl)+'">Install do Stremia</a></p>'+
      '<p><a href="'+html(manifestUrl)+'" target="_blank">Otvoriť manifest v prehliadači</a></p>';
  }
  document.getElementById('genBtn').addEventListener('click', generate);
})();
</script>
</body></html>`);
});

app.post('/configure', (req, res) => {
  const token = b64urlEncode({
    username: req.body.username || '',
    password: req.body.password || ''
  });
  res.redirect(`/${token}/manifest.json`);
});

app.get('/debug/login', async (req, res) => {
  res.json({ ok: true, version: VERSION, login: await login(getCredentials(req)) });
});
app.get('/:config/debug/login', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({ ok: true, version: VERSION, login: await login(getCredentials(req)) });
});

async function sendDebugSearch(req, res) {
  const auth = await login(getCredentials(req));
  if (!auth.ok) return res.json({ ok: true, version: VERSION, auth, resultCount: 0, files: [] });
  const result = await searchFastshare(req.query.term || 'avatar', auth.hash);
  return res.json({
    ok: true,
    version: VERSION,
    auth: { ok: true, hasHash: true, source: auth.source },
    ...result
  });
}
app.get('/debug/search', sendDebugSearch);
app.get('/:config/debug/search', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  return sendDebugSearch(req, res, next);
});

async function sendDebugMeta(req, res) {
  try {
    const meta = await getMeta(req.params.type, req.params.id);
    res.json({
      ok: true,
      version: VERSION,
      meta,
      aliases: getTitleAliases(meta),
      terms: termsFor(meta),
      searchPlan: searchTermPlan(meta)
    });
  } catch (error) {
    res.status(500).json({ ok: false, version: VERSION, error: String(error.stack || error) });
  }
}
app.get('/debug/meta/:type/:id.json', sendDebugMeta);
app.get('/:config/debug/meta/:type/:id.json', sendDebugMeta);

app.get('/stream/:type/:id.json', async (req, res) => {
  try { res.json(await buildStreamResponse(req, false)); }
  catch { res.json({ streams: [] }); }
});
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json(await buildStreamResponse(req, false)); }
  catch { res.json({ streams: [] }); }
});
app.get('/debug/stream/:type/:id.json', async (req, res) => {
  try { res.json(await buildStreamResponse(req, true)); }
  catch (error) { res.status(500).json({ ok: false, version: VERSION, error: String(error.stack || error) }); }
});
app.get('/:config/debug/stream/:type/:id.json', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json(await buildStreamResponse(req, true)); }
  catch (error) { res.status(500).json({ ok: false, version: VERSION, error: String(error.stack || error) }); }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`FastShare Stremio addon v${VERSION} on ${PORT}`));
}

module.exports = {
  app,
  manifest,
  buildStreamResponse,
  streamObj,
  getCredentials,
  getMeta,
  getLocalizedTitleData,
  extractTmdbLocalizedAliases,
  extractWikidataLocalizedAliases,
  getTitleAliases,
  detectAudio,
  rankFiles,
  searchTermPlan,
  termsFor,
  detectBadgeTags,
  buildExtraNuvioFilters,
  adaptNardBadgeFilters,
  mergeNuvioBadgeFilters,
  NARD_BADGES_URL
};
