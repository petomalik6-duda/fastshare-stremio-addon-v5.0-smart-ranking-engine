const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VERSION = '6.3.1';
const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const API = 'https://fastshare.cz/api/api_kodi.php';

function getBase(req) {
  return BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function encodeConfig(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeConfig(str) {
  try {
    return JSON.parse(Buffer.from(String(str || ''), 'base64url').toString('utf8'));
  } catch (_) {
    try {
      const padded = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (_) {
      return {};
    }
  }
}

function getConfig(req) {
  const decoded = req.params.config ? decodeConfig(req.params.config) : {};
  return {
    username: decoded.username || process.env.FASTSHARE_USERNAME || '',
    password: decoded.password || process.env.FASTSHARE_PASSWORD || '',
    maxStreams: Number(decoded.maxStreams || process.env.MAX_STREAMS || 25)
  };
}

function normalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(s) {
  const stop = new Set([
    'the','a','an','and','or','of','to','in','on','for','from','with','bez','cz','sk','en','eng',
    'dab','dabing','audio','tit','titulky','subs','sub','mkv','mp4','avi','1080p','720p','2160p',
    '4k','hd','uhd','fhd','fullhd','bluray','bdrip','webrip','web','dl','x264','x265','h264','h265'
  ]);
  return normalize(s).split(/\s+/).filter(w => w && w.length > 1 && !stop.has(w));
}

function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]{2,5})(?:$|[\s._-])/i);
  return m ? m[1].toUpperCase() : '';
}

function qualityOf(name) {
  const n = normalize(name);
  if (/2160p|4k|uhd|uhdr/.test(n)) return '4K';
  if (/1080p|fullhd|fhd/.test(n)) return '1080p';
  if (/720p| hd /.test(` ${n} `)) return '720p';
  if (/480p|sd/.test(n)) return '480p';
  return '';
}

function sizeText(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  const mb = n / (1024 ** 2);
  return `${Math.round(mb)} MB`;
}

function durationText(seconds) {
  const s = Number(seconds || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function detectAudio(name) {
  const n = normalize(name);

  const czSubs = /\b(cz\s*tit|cztit|cz\s*titulky|cz\s*sub|cz\s*subs|cz\s*subtitle|cz\s*title|czforced|czech\s*subs|ceske\s*titulky)\b/.test(n);
  const skSubs = /\b(sk\s*tit|sktit|sk\s*titulky|sk\s*sub|sk\s*subs|sk\s*subtitle|sk\s*title|slovak\s*subs|slovenske\s*titulky)\b/.test(n);

  const hasCzDub = /\b(cz\s*dab|czdab|cz\s*dabing|czech\s*(audio|dub|dabing)|cesky\s*dabing|cze\s*(audio|dub))\b/.test(n);
  const hasSkDub = /\b(sk\s*dab|skdab|sk\s*dabing|slovak\s*(audio|dub|dabing)|slovensky\s*dabing|svk\s*(audio|dub))\b/.test(n);

  const hasEnAudio = /\b(en|eng|english)\s*(audio|dabing|dub)?\b/.test(n) || /\b(en|eng)\b/.test(n);
  const hasCzToken = /\b(cz|cze|ces|cs|czech)\b/.test(n);
  const hasSkToken = /\b(sk|svk|slovak)\b/.test(n);

  let label = 'Audio neznáme';
  let lang = 'any';
  let score = 0;

  if (hasCzDub) { label = 'CZ Dabing'; lang = 'CZ'; score = 110; }
  else if (hasSkDub) { label = 'SK Dabing'; lang = 'SK'; score = 90; }
  else if (hasCzToken && hasEnAudio && !czSubs) { label = 'CZ/EN Audio'; lang = 'CZEN'; score = 80; }
  else if (hasSkToken && hasEnAudio && !skSubs) { label = 'SK/EN Audio'; lang = 'SKEN'; score = 65; }
  else if (hasEnAudio) { label = 'EN Audio'; lang = 'EN'; score = 35; }
  else if (/\b(multi\s*audio|dual\s*audio|dual)\b/.test(n)) { label = 'Multi Audio'; lang = 'MULTI'; score = 25; }

  const subs = [];
  if (czSubs) subs.push('CZ titulky');
  if (skSubs) subs.push('SK titulky');

  if (subs.length && label === 'Audio neznáme' && hasEnAudio) {
    label = 'EN Audio'; lang = 'EN'; score = 35;
  }
  if (czSubs) score += 18;
  if (skSubs) score += 12;
  return { label, lang, subs, score };
}

async function getMeta(type, id) {
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`, { timeout: 8000 });
    const j = await res.json();
    const m = j.meta || {};
    return {
      type,
      imdbId: id,
      title: m.name || m.title || id,
      year: String(m.year || m.releaseInfo || '').slice(0, 4),
      runtime: parseInt(String(m.runtime || '').match(/\d+/)?.[0] || '0', 10),
      raw: m
    };
  } catch (e) {
    return { type, imdbId: id, title: id, year: '', runtime: 0, raw: {}, error: String(e.message || e) };
  }
}

async function fastshareLogin(username, password) {
  if (!username || !password) return { ok: false, reason: 'missing credentials' };
  const params = new URLSearchParams({ process: 'login', kodi: '1', username, password });
  const res = await fetch(`${API}?${params.toString()}`, { headers: { 'user-agent': 'Kodi/20 FastShare Stremio Addon' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  const hash = json?.login?.hash || json?.hash || json?.user?.hash || json?.status?.hash || null;
  if (hash) return { ok: true, hash, source: 'login', status: res.status };
  return { ok: false, status: res.status, preview: text.slice(0, 500), json };
}

let authCache = { key: '', hash: '', ts: 0 };

async function getHash(cfg) {
  const envHash = process.env.FASTSHARE_HASH || process.env.FASTSHARE_SESSION || '';
  if (envHash) return { ok: true, hash: envHash, source: 'env' };
  const key = `${cfg.username}:${cfg.password}`;
  if (authCache.key === key && authCache.hash && Date.now() - authCache.ts < 6 * 60 * 60 * 1000) {
    return { ok: true, hash: authCache.hash, source: 'cache' };
  }
  const login = await fastshareLogin(cfg.username, cfg.password);
  if (login.ok) {
    authCache = { key, hash: login.hash, ts: Date.now() };
    return { ok: true, hash: login.hash, source: 'login' };
  }
  return login;
}

async function searchFastshare(term, hash) {
  const params = new URLSearchParams({ process: 'search', pagination: '200', term, adult: '0' });
  if (hash) params.set('hash', hash);
  const url = `${API}?${params.toString()}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Kodi/20 FastShare Stremio Addon' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  const arr = json?.search?.file || json?.file || json?.files || [];
  const files = (Array.isArray(arr) ? arr : [arr]).filter(Boolean).map(f => {
    const size = Number(f?.data?.value || f?.size || 0);
    const name = f.filename || f.name || '';
    const url = f.download_url || f.url || '';
    const dur = Number(f?.duration?.value || 0);
    return {
      id: String(f.id || ''), name, size, url,
      image: f.thumbnail || f.image || '',
      duration: dur,
      durationText: f.duration_f || durationText(dur),
      raw: f
    };
  }).filter(f => f.id && f.name && f.url);
  return { status: res.status, apiUrl: url, resultCount: files.length, files, preview: text.slice(0, 500) };
}

function buildTerms(meta) {
  const title = meta.title || '';
  const w = words(title);
  const terms = [];
  if (title && meta.year) terms.push(`${title} ${meta.year}`);
  if (title) terms.push(title);
  if (w.length >= 2) terms.push(w.join(' '));
  if (w.length > 2) terms.push(w.slice(0, 3).join(' '));
  return [...new Set(terms.filter(Boolean))];
}

function titleMatchScore(name, meta) {
  const n = normalize(name);
  const title = normalize(meta.title);
  const titleWords = words(meta.title);
  const nameWords = new Set(words(name));
  if (!title) return { score: 0, reason: 'no-title' };
  if (n.includes(title)) return { score: 110, reason: 'title-phrase +110' };
  if (titleWords.length >= 2) {
    const matched = titleWords.filter(w => nameWords.has(w)).length;
    const ratio = matched / titleWords.length;
    if (ratio >= 0.67) return { score: 70, reason: 'relaxed-title +70' };
    return { score: -220, reason: 'title-mismatch -220' };
  }
  const one = titleWords[0];
  if (one && nameWords.has(one)) return { score: 40, reason: 'single-word-title +40' };
  return { score: -220, reason: 'single-word-mismatch -220' };
}

function hasBadYear(name, meta) {
  const n = normalize(name);
  const y = n.match(/\b(19\d{2}|20\d{2})\b/);
  return Boolean(meta.year && y && y[1] !== meta.year);
}

function sequelMismatch(name, meta) {
  const titleWords = words(meta.title);
  if (titleWords.length !== 1) return false;
  const t = titleWords[0];
  const n = normalize(name);
  return new RegExp(`\\b${t}\\s*(2|3|4|5|ii|iii|iv|v)\\b`).test(n);
}

function scoreFile(file, meta, type) {
  let score = 0;
  const reasons = [];
  const n = normalize(file.name);
  const tm = titleMatchScore(file.name, meta);
  score += tm.score; reasons.push(tm.reason);
  if (meta.year && n.includes(meta.year)) { score += 65; reasons.push('year +65'); }
  if (hasBadYear(file.name, meta)) { score -= 260; reasons.push('different-year -260'); }
  if (type === 'movie' && sequelMismatch(file.name, meta)) { score -= 260; reasons.push('sequel-mismatch -260'); }
  if (type === 'movie' && /\b(s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2})\b/.test(n)) { score -= 260; reasons.push('episode-in-movie -260'); }
  const audio = detectAudio(file.name);
  score += audio.score; reasons.push(`${audio.label} +${audio.score}`);
  const q = qualityOf(file.name);
  if (q === '4K') { score += 30; reasons.push('4K +30'); }
  else if (q === '1080p') { score += 20; reasons.push('1080p +20'); }
  else if (q === '720p') { score += 10; reasons.push('720p +10'); }
  const ext = extOf(file.name);
  if (ext === 'MKV') { score += 10; reasons.push('MKV +10'); }
  else if (ext === 'MP4') { score += 8; reasons.push('MP4 +8'); }
  else if (ext === 'AVI') { score -= 3; reasons.push('AVI -3'); }
  const gb = Number(file.size || 0) / (1024 ** 3);
  if (gb > 15) { score += 25; reasons.push('size >15GB +25'); }
  else if (gb > 10) { score += 20; reasons.push('size >10GB +20'); }
  else if (gb > 6) { score += 15; reasons.push('size >6GB +15'); }
  else if (gb > 3) { score += 10; reasons.push('size >3GB +10'); }
  else if (gb > 1) { score += 5; reasons.push('size >1GB +5'); }
  if (/\b(cam|ts|hdcam|telesync|trailer|ukazka)\b/.test(n)) { score -= 150; reasons.push('bad-quality -150'); }
  if (!/\.(mkv|mp4|avi|m4v|mov|webm)(?:$|[\s._-])/i.test(file.name)) { score -= 80; reasons.push('unknown-video-ext -80'); }
  if (type === 'movie' && file.size && file.size < 200 * 1024 * 1024) { score -= 180; reasons.push('too-small-movie -180'); }
  return { ...file, score, reasons, audio, quality: q, ext, sizeText: sizeText(file.size) };
}

function makeStreamUrl(file, hash) {
  const sep = file.url.includes('?') ? '&' : '?';
  const filename = encodeURIComponent(file.name || 'video.mp4');
  return `${file.url}${sep}stream=1&session=${encodeURIComponent(hash)}&${filename}`;
}

function makeManifest(configPath = '') {
  return {
    id: configPath ? 'community.fastshare.smart.streams.v631.configured' : 'community.fastshare.smart.streams.v631',
    version: VERSION,
    name: configPath ? 'FastShare Smart' : 'FastShare Smart Configure',
    description: 'FastShare stream addon with safe startup, relaxed matching and strict subtitles/audio detection.',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'], catalogs: [], idPrefixes: ['tt'],
    behaviorHints: configPath ? { configurable: false, configurationRequired: false } : { configurable: true, configurationRequired: true },
    config: [
      { key: 'username', type: 'text', title: 'FastShare username' },
      { key: 'password', type: 'password', title: 'FastShare password' }
    ]
  };
}

function renderConfigurePage(req, generatedUrl = '', error = '') {
  const stremioUrl = generatedUrl ? 'stremio://' + generatedUrl.replace(/^https?:\/\//, '') : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FastShare Configure</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.45}input,button,a.button{font-size:16px;padding:12px;margin:7px 0;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #bbb}button,a.button{background:#111;color:white;text-align:center;text-decoration:none;display:block;cursor:pointer}code{word-break:break-all;background:#f0f0f0;padding:10px;display:block;border-radius:8px;color:#111}.err{background:#ffe9e9;color:#900;padding:10px;border-radius:8px}.ok{background:#eaffea;padding:10px;border-radius:8px}.small{font-size:14px;color:#555}</style></head><body><h1>FastShare Smart konfigurácia</h1><p>Zadaj FastShare prihlasovacie údaje. Konfigurácia sa uloží iba do tvojej manifest URL.</p>${error ? `<div class="err">${error}</div>` : ''}<form method="post" action="/configure"><input name="username" placeholder="FastShare login" autocomplete="username" required><input name="password" placeholder="FastShare heslo" type="password" autocomplete="current-password" required><button type="submit">Vygenerovať manifest URL</button></form>${generatedUrl ? `<div class="ok"><b>Manifest URL:</b><code id="manifestUrl">${generatedUrl}</code></div><a class="button" href="${stremioUrl}">Otvoriť v Stremio</a><button type="button" onclick="copyUrl()">Kopírovať manifest URL</button><p class="small">Ak sa Stremio neotvorí automaticky, skopíruj URL a vlož ju ručne do Stremia.</p>` : ''}<script>function copyUrl(){const el=document.getElementById('manifestUrl');if(!el)return;const text=el.textContent;if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>alert('Skopírované'))}else{prompt('Skopíruj manifest URL:',text);}}</script></body></html>`;
}

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));
app.get('/configure', (req, res) => res.type('html').send(renderConfigurePage(req)));
app.post('/configure', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.type('html').send(renderConfigurePage(req, '', 'Chýba login alebo heslo.'));
  const cfg = encodeConfig({ username, password });
  res.type('html').send(renderConfigurePage(req, `${getBase(req)}/${cfg}/manifest.json`));
});
app.get('/manifest.json', (req, res) => res.json(makeManifest('')));
app.get('/:config/manifest.json', (req, res) => res.json(makeManifest(req.params.config)));

async function handleStream(req, res, debug = false) {
  try {
    const cfg = getConfig(req);
    const { type, id } = req.params;
    const realId = String(id || '').split(':')[0];
    const meta = await getMeta(type, realId);
    const auth = await getHash(cfg);
    if (!auth.ok) return res.json(debug ? { ok: true, version: VERSION, auth, streams: [] } : { streams: [] });
    const terms = buildTerms(meta);
    const search = [];
    let all = [];
    for (const term of terms) {
      const s = await searchFastshare(term, auth.hash);
      search.push({ term, status: s.status, resultCount: s.resultCount, apiUrl: s.apiUrl, firstFiles: s.files.slice(0, 3) });
      all.push(...s.files);
    }
    const seen = new Set();
    const ranked = all.filter(f => !seen.has(f.id) && seen.add(f.id)).map(f => scoreFile(f, meta, type)).filter(f => f.score > 20).sort((a, b) => b.score - a.score).slice(0, cfg.maxStreams || 25);
    const streams = ranked.map((f, idx) => {
      const info = [f.quality, f.sizeText, f.ext, f.durationText].filter(Boolean).join(' • ');
      const audioLine = [f.audio.label, ...(f.audio.subs || [])].filter(Boolean).join(' • ');
      return { name: `FastShare ${f.audio.lang && f.audio.lang !== 'any' ? f.audio.lang : ''}`.trim(), title: `${idx === 0 ? '⭐ Odporúčané\n' : ''}${f.name}\n${info}\n${audioLine}`, url: makeStreamUrl(f, auth.hash), behaviorHints: { bingeGroup: `fastshare-${f.quality || 'auto'}-${f.audio.lang || 'any'}` } };
    });
    if (debug) return res.json({ ok: true, version: VERSION, request: { type, id }, meta, terms, auth: { ok: true, source: auth.source, hasHash: !!auth.hash }, search, streamCount: streams.length, files: ranked, streams });
    return res.json({ streams });
  } catch (e) {
    if (debug) return res.json({ ok: false, version: VERSION, error: String(e.stack || e.message || e) });
    return res.json({ streams: [] });
  }
}

async function debugLogin(req, res) {
  const cfg = getConfig(req);
  const auth = await getHash(cfg);
  res.json({ ok: true, version: VERSION, hasUsername: !!cfg.username, hasPassword: !!cfg.password, login: auth });
}

async function debugSearch(req, res) {
  const cfg = getConfig(req);
  const auth = await getHash(cfg);
  if (!auth.ok) return res.json({ ok: true, version: VERSION, auth, resultCount: 0, results: [] });
  const term = req.query.term || 'avatar';
  const s = await searchFastshare(term, auth.hash);
  res.json({ ok: true, version: VERSION, term, auth: { ok: true, source: auth.source }, status: s.status, resultCount: s.resultCount, apiUrl: s.apiUrl, results: s.files.slice(0, 50) });
}

app.get('/debug/login', debugLogin);
app.get('/:config/debug/login', debugLogin);
app.get('/debug/search', debugSearch);
app.get('/:config/debug/search', debugSearch);
app.get('/debug/stream/:type/:id.json', (req, res) => handleStream(req, res, true));
app.get('/:config/debug/stream/:type/:id.json', (req, res) => handleStream(req, res, true));
app.get('/stream/:type/:id.json', (req, res) => handleStream(req, res, false));
app.get('/:config/stream/:type/:id.json', (req, res) => handleStream(req, res, false));
app.get('/', (req, res) => res.redirect('/configure'));

app.listen(PORT, () => {
  console.log(`FastShare Stremio addon v${VERSION} running on port ${PORT}`);
});
