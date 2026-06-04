const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const VERSION = '6.1.4';
const API = 'https://fastshare.cz/api/api_kodi.php';
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 60);

const authCache = new Map();

function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function b64urlDecode(str) {
  try { return JSON.parse(Buffer.from(str, 'base64url').toString('utf8')); } catch { return {}; }
}
function safeText(v) { return String(v || '').replace(/[<>]/g, ''); }
function normalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function slug(s) { return normalize(s).replace(/\s+/g, '-'); }
function esc(s) { return encodeURIComponent(String(s || '')); }
function bytesToHuman(bytes) {
  const n = Number(bytes || 0); if (!n) return '';
  const units = ['B','KB','MB','GB','TB']; let x = n, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return i < 2 ? `${Math.round(x)} ${units[i]}` : `${x.toFixed(x >= 10 ? 0 : 1)} ${units[i]}`;
}
function parseRuntimeSeconds(meta) {
  const r = meta && (meta.runtime || meta.raw?.runtime);
  const m = String(r || '').match(/(\d+)\s*min/i);
  return m ? Number(m[1]) * 60 : 0;
}
function getExt(name) {
  const m = String(name || '').match(/\.([a-z0-9]{2,5})(?:$|[\s\]\)])/i);
  if (!m) return '';
  const ext = m[1].toUpperCase();
  return ['MKV','MP4','AVI','MOV','M4V'].includes(ext) ? ext : '';
}
function detectQuality(name) {
  const n = normalize(name);
  if (/\b(2160p|4k|uhd|uhdr)\b/.test(n)) return '4K';
  if (/\b(1080p|fullhd|fhd)\b/.test(n)) return '1080p';
  if (/\b720p\b/.test(n)) return '720p';
  if (/\b(480p|sd)\b/.test(n)) return '480p';
  return '';
}
function detectAudio(name) {
  const n = normalize(name);
  const raw = String(name || '').toLowerCase();

  // Subtitles must be detected before generic CZ/SK tokens.
  // Important: "CZ tit/subs/title/forced" is NOT CZ audio.
  const czSubs = /\b(cz|cze|cs|ceske|cesky|czech)\s*(tit|titulky|sub|subs|subtitle|forced|title)\b|cztit|czforced/.test(n);
  const skSubs = /\b(sk|svk|slovak|slovensky)\s*(tit|titulky|sub|subs|subtitle|forced|title)\b|sktit|skforced/.test(n);

  const czDubStrong = /czdab|\b(cz|cze|cs|ceske|cesky)\s*(dab|dub|dabing|dubbing|audio)\b|\b(czech)\s*(audio|dub|dubbing)\b/.test(n);
  const skDubStrong = /skdab|\b(sk|svk|slovak|slovensky)\s*(dab|dub|dabing|dubbing|audio)\b|\b(slovak)\s*(audio|dub|dubbing)\b/.test(n);
  const enStrong = /\b(en|eng|english)\s*(audio|dab|dub|dabing|dubbing)\b|\b(en|eng)\s*dabing\b/.test(n);

  const hasCZ = /(^|[^a-z])(cz|cze|cs|cesky|czech)([^a-z]|$)/.test(n) || /czhd/i.test(raw);
  const hasSK = /(^|[^a-z])(sk|svk|slovak|slovensky)([^a-z]|$)/.test(n);
  const hasEN = /(^|[^a-z])(en|eng|english)([^a-z]|$)/.test(n);
  const explicitMulti = /multi\s*audio|dual\s*audio|dual/.test(n);

  let label = 'Audio neznáme', key = 'any', score = 0;

  if (czDubStrong && skDubStrong) { label = 'CZ/SK Dabing'; key = 'CZ-SK'; score = 105; }
  else if (czDubStrong) { label = 'CZ Dabing'; key = 'CZ'; score = 100; }
  else if (skDubStrong) { label = 'SK Dabing'; key = 'SK'; score = 80; }
  else if (hasCZ && hasEN && !czSubs) { label = 'CZ/EN Audio'; key = 'CZ-EN'; score = 85; }
  else if (hasSK && hasEN && !skSubs) { label = 'SK/EN Audio'; key = 'SK-EN'; score = 55; }
  else if (enStrong || hasEN) { label = 'EN Audio'; key = 'EN'; score = 40; }
  else if (explicitMulti) { label = 'Multi Audio'; key = 'multi'; score = 30; }
  else if (czSubs) { label = 'CZ titulky'; key = 'sub'; score = 5; }
  else if (skSubs) { label = 'SK titulky'; key = 'sub'; score = 5; }
  else if (hasCZ) { label = 'CZ neoverené'; key = 'CZ'; score = 20; }
  else if (hasSK) { label = 'SK neoverené'; key = 'SK'; score = 15; }

  const subs = [];
  if (czSubs && label !== 'CZ titulky') subs.push('CZ titulky');
  if (skSubs && label !== 'SK titulky') subs.push('SK titulky');
  const subScore = (czSubs && label !== 'CZ titulky' ? 15 : 0) + (skSubs && label !== 'SK titulky' ? 10 : 0);
  return { label, key, score, subs, subScore };
}
function hasEpisodePattern(name) {
  return /\bS\d{1,2}E\d{1,2}\b/i.test(name) || /\b\d{1,2}x\d{1,2}\b/i.test(name);
}
function episodePatternScore(name, meta) {
  if (meta.type !== 'series' || !meta.season || !meta.episode) return { score: 0, reason: null };
  const raw = String(name || '');
  const n = normalize(raw);
  const s = Number(meta.season);
  const e = Number(meta.episode);
  const sp = String(s).padStart(2, '0');
  const ep = String(e).padStart(2, '0');

  const patterns = [
    new RegExp('\\bs0?' + s + 'e0?' + e + '\\b', 'i'),
    new RegExp('\\b0?' + s + 'x0?' + e + '\\b', 'i'),
    new RegExp('\\bseries\\s*0?' + s + '\\s*episode\\s*0?' + e + '\\b', 'i'),
    new RegExp('\\bseason\\s*0?' + s + '\\s*episode\\s*0?' + e + '\\b', 'i')
  ];
  if (patterns.some(rx => rx.test(raw) || rx.test(n))) return { score: 180, reason: 'episode-pattern +180' };

  // Weaker Czech/Slovak style fallback: title ... 01 02 / ep 02
  if (new RegExp('\\b(ep|dil|cast|epizoda)\\s*0?' + e + '\\b', 'i').test(n)) {
    return { score: 80, reason: 'episode-number +80' };
  }
  return { score: 0, reason: null };
}
function seriesEpisodeMismatch(name, meta) {
  if (meta.type !== 'series' || !meta.season || !meta.episode) return false;
  const raw = String(name || '');
  const n = normalize(raw);
  const s = Number(meta.season);
  const e = Number(meta.episode);

  const se = raw.match(/\bS(\d{1,2})E(\d{1,2})\b/i) || raw.match(/\b(\d{1,2})x(\d{1,2})\b/i);
  if (!se) return false;
  const fs = Number(se[1]);
  const fe = Number(se[2]);
  return fs !== s || fe !== e;
}
function getYears(name) {
  return [...String(name || '').matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => m[1]);
}
function sequelMismatch(name, title, year) {
  const n = normalize(name), t = normalize(title);
  if (!t) return false;
  if (t === 'avatar' && /\bavatar\s*(2|two)\b/.test(n)) return true;
  if (t === 'dune' && /\bdune\s*(2|part\s*two|cast\s*two)\b/.test(n) && String(year) !== '2024') return true;
  return false;
}
function titleMatchScore(fileName, meta, type) {
  const title = normalize(meta.title || meta.name || '');
  const file = normalize(fileName);
  const year = String(meta.year || meta.releaseInfo || '').match(/\d{4}/)?.[0] || '';
  let score = 0, reasons = [];

  if (type === 'movie' && hasEpisodePattern(fileName)) {
    return { reject: true, score: -999, reasons: ['movie-episode-pattern reject'] };
  }
  if (type === 'series' && seriesEpisodeMismatch(fileName, meta)) {
    return { reject: true, score: -999, reasons: ['series-episode-mismatch reject'] };
  }
  if (sequelMismatch(fileName, meta.title, year)) {
    return { reject: true, score: -999, reasons: ['sequel-mismatch reject'] };
  }

  const tokens = title.split(' ').filter(x => x.length > 1);
  const hit = tokens.filter(tok => file.includes(tok)).length;
  const strongTitle = Boolean(tokens.length && (hit === tokens.length || hit >= 2 || (hit / tokens.length) >= 0.67));

  if (tokens.length && hit === tokens.length) { score += 100; reasons.push('exact-title +100'); }
  else if (hit > 0) { const pts = Math.min(50, hit * 15); score += pts; reasons.push(`title-tokens +${pts}`); }
  else { score -= 80; reasons.push('title-miss -80'); }

  const years = getYears(fileName);
  if (year) {
    if (years.includes(year)) {
      score += 50; reasons.push('year +50');
    } else if (years.length) {
      const fileYear = Number(years[0]);
      const metaYear = Number(year);
      const diff = Math.abs(fileYear - metaYear);

      // General release-year fix: if the title is a strong match, do not reject only
      // because Cinemeta/TMDB uses a different release year than the filename.
      if (strongTitle && diff === 1) { score -= 20; reasons.push('year off by 1 strong-title -20'); }
      else if (strongTitle && diff <= 2) { score -= 45; reasons.push('year off by 2 strong-title -45'); }
      else if (strongTitle) { score -= 90; reasons.push('different-year strong-title -90'); }
      else { return { reject: true, score: -999, reasons: ['different-year weak-title reject'] }; }
    }
  }
  const eps = episodePatternScore(fileName, meta);
  if (eps.score) { score += eps.score; reasons.push(eps.reason); }

  // For series, an exact episode pattern is often more reliable than title words,
  // because FastShare may use translated series names.
  if (type === 'series' && eps.score && reasons.includes('title-miss -80')) {
    score += 60;
    reasons.push('series-title-relaxed +60');
  }

  return { reject: false, score, reasons };
}
function runtimeScore(file, meta) {
  const expected = parseRuntimeSeconds(meta);
  const dur = Number(file.duration || file.raw?.duration?.value || 0);
  if (!expected || !dur) return { score: 0, reason: null };
  const diff = Math.abs(dur - expected);
  if (diff <= 180) return { score: 25, reason: 'runtime exact +25' };
  if (diff <= 1500) return { score: 15, reason: 'runtime close +15' };
  if (diff >= 3000) return { score: -50, reason: 'runtime far -50' };
  return { score: 0, reason: null };
}
function qualityScore(q) {
  if (q === '4K') return [30, '4K +30'];
  if (q === '1080p') return [20, '1080p +20'];
  if (q === '720p') return [10, '720p +10'];
  if (q === '480p') return [-5, '480p -5'];
  return [0, null];
}
function extScore(ext) {
  if (ext === 'MKV') return [10, 'MKV +10'];
  if (ext === 'MP4') return [8, 'MP4 +8'];
  if (ext === 'AVI') return [-3, 'AVI -3'];
  return [0, null];
}
function sizeScore(bytes) {
  const gb = Number(bytes || 0) / 1024 / 1024 / 1024;
  if (gb > 15) return [25, 'size >15GB +25'];
  if (gb > 10) return [20, 'size >10GB +20'];
  if (gb > 6) return [15, 'size >6GB +15'];
  if (gb > 3) return [10, 'size >3GB +10'];
  if (gb > 1) return [5, 'size >1GB +5'];
  if (gb && gb < 0.4) return [-40, 'size too small -40'];
  return [0, null];
}
function badQualityPenalty(name) {
  const n = normalize(name);
  if (/\b(cam|hdcam|ts|telesync|tc|workprint|trailer|sample)\b/.test(n)) return [-120, 'bad-release -120'];
  return [0, null];
}
function scoreFile(file, meta, type) {
  const name = file.name || file.filename || file.raw?.filename || '';
  const m = titleMatchScore(name, meta, type);
  if (m.reject) return null;
  let score = m.score; const reasons = [...m.reasons];
  const audio = detectAudio(name); score += audio.score + audio.subScore; reasons.push(`${audio.label} +${audio.score}`); if (audio.subScore) reasons.push(`subtitles +${audio.subScore}`);
  const q = detectQuality(name); const [qs, qr] = qualityScore(q); score += qs; if (qr) reasons.push(qr);
  const ext = getExt(name); const [es, er] = extScore(ext); score += es; if (er) reasons.push(er);
  const [ss, sr] = sizeScore(file.size || file.raw?.data?.value); score += ss; if (sr) reasons.push(sr);
  const rt = runtimeScore(file, meta); score += rt.score; if (rt.reason) reasons.push(rt.reason);
  const [bp, br] = badQualityPenalty(name); score += bp; if (br) reasons.push(br);
  return { ...file, score, scoreReasons: reasons, audio, quality: q, ext };
}
function dedupe(files) {
  const map = new Map();
  for (const f of files) {
    const nameKey = normalize(f.name).replace(/\b(2160p|1080p|720p|480p|4k|uhd|fullhd|fhd|mkv|mp4|avi|cz|sk|en|eng|cze|dabing|dab|extended|cut)\b/g, '').replace(/\s+/g, ' ').trim();
    const key = `${nameKey}|${f.quality}|${f.audio.key}`;
    if (!map.has(key) || f.score > map.get(key).score) map.set(key, f);
  }
  return [...map.values()];
}
function manifest(configToken = null) {
  const prefix = configToken ? `/${configToken}` : '';
  return {
    id: 'community.fastshare.kodiapi.configurator.v6',
    version: VERSION,
    name: 'FastShare Kodi API',
    description: 'FastShare streams using FastShare Kodi API. Configure with your own lawful account. Includes Stremio/Nuvio series routes.',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: [{ name: 'stream', types: ['movie','series'], idPrefixes: ['tt', ''] }],
    types: ['movie','series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true, configurationRequired: !configToken },
    config: [{ key: 'username', type: 'text', title: 'FastShare username' }, { key: 'password', type: 'password', title: 'FastShare password' }]
  };
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
async function login(creds) {
  const username = creds.username, password = creds.password;
  if (!username || !password) return { ok: false, error: 'missing credentials' };
  const cacheKey = crypto.createHash('sha1').update(username + ':' + password).digest('hex');
  const cached = authCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 1000 * 60 * 55) return { ok: true, hash: cached.hash, source: 'cache' };
  const url = `${API}?process=login&login=${esc(username)}&password=${esc(password)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Kodi/20 FastShare Stremio' } });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = null; }
  const hash = json?.user?.hash || json?.hash || json?.data?.hash;
  if (!hash) return { ok: false, status: res.status, preview: txt.slice(0, 300) };
  authCache.set(cacheKey, { hash, ts: Date.now() });
  return { ok: true, hash, source: 'login', status: res.status };
}
async function getMeta(type, id) {
  if (!id.startsWith('tt')) return { type, imdbId: id, stremioId: id, title: id, year: '', season: null, episode: null, raw: {} };
  const clean = id.split(':')[0];
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${clean}.json`;
  const res = await fetch(url); const json = await res.json();
  const meta = json.meta || {};
  const parts = id.split(':');
  return { type, imdbId: clean, stremioId: id, title: meta.name || meta.title || clean, year: String(meta.year || meta.releaseInfo || '').slice(0,4), season: parts[1] ? Number(parts[1]) : null, episode: parts[2] ? Number(parts[2]) : null, raw: meta };
}
function termsFor(meta) {
  const title = meta.title || '';
  const arr = [];

  if (meta.type === 'series' && meta.season && meta.episode) {
    const s = Number(meta.season);
    const e = Number(meta.episode);
    const sp = String(s).padStart(2, '0');
    const ep = String(e).padStart(2, '0');

    const titles = [title];
    const normalizedTitle = normalize(title);
    const tokens = normalizedTitle.split(' ').filter(x => x.length > 2 && !['the','and','for','with','from'].includes(x));
    if (tokens.length >= 2) titles.push(tokens.join(' '));
    if (tokens.length >= 1) titles.push(tokens[tokens.length - 1]);

    for (const t of [...new Set(titles.filter(Boolean))]) {
      arr.push(`${t} S${sp}E${ep}`);
      arr.push(`${t} S${s}E${e}`);
      arr.push(`${t} ${s}x${ep}`);
      arr.push(`${t} ${s}x${e}`);
      arr.push(`${t} season ${s} episode ${e}`);
      arr.push(`${t} ep ${e}`);
      arr.push(`${t}`);
    }

    // Last-resort query by imdb/title only is intentionally kept last.
    return [...new Set(arr.filter(Boolean))];
  }

  if (title) arr.push(title);
  if (title && meta.year) arr.push(`${title} ${meta.year}`);

  // General fallback for titles where FastShare stores a translated title or a different release year.
  const tokens = normalize(title).split(' ').filter(x => x.length > 2 && !['the','and','for','with','from'].includes(x));
  if (tokens.length >= 2) arr.push(tokens.join(' '));
  if (tokens.length >= 1) arr.push(tokens[tokens.length - 1]);

  return [...new Set(arr.filter(Boolean))];
}
function mapFile(raw) {
  const name = raw.filename || raw.name || '';
  return { id: raw.id, name, size: raw.data?.value || raw.size || 0, url: raw.download_url || raw.url, image: raw.thumbnail, duration: raw.duration?.value || raw.duration || '', durationText: raw.duration_f || '', resolution: raw.resolution, raw };
}
async function searchFastshare(term, hash) {
  const url = `${API}?process=search&pagination=200&term=${esc(term)}&adult=0`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Kodi/20 FastShare Stremio', 'Cookie': `FASTSHARE=${hash}` } });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = null; }
  const list = json?.search?.file || json?.file || json?.files || [];
  return { term, status: res.status, resultCount: Array.isArray(list) ? list.length : 0, apiUrl: url, files: Array.isArray(list) ? list.map(mapFile) : [], rawPreview: txt.slice(0, 500) };
}
function streamUrl(file, hash) {
  const base = file.url || file.raw?.download_url;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}stream=1&session=${esc(hash)}&${esc(file.name)}`;
}
function streamObj(file, hash, recommended) {
  const size = bytesToHuman(file.size);
  const bits = [file.quality, size, file.ext, file.durationText].filter(Boolean).join(' • ');
  const lang = [file.audio.label, ...(file.audio.subs || [])].filter(Boolean).join(' • ');
  const title = `${recommended ? '⭐ Odporúčané\n' : ''}${file.name}\n${bits}\n${lang}`;
  return { name: `FastShare${file.audio.key !== 'any' ? ' ' + file.audio.key.replace('-', '/') : ''}`, title, url: streamUrl(file, hash), behaviorHints: { bingeGroup: `fastshare-${file.quality || 'auto'}-${file.audio.key}` } };
}

function makeStreamObject(f, idx, streamUrl) {
  const info = [f.quality, f.sizeText, f.ext, f.durationText].filter(Boolean).join(' • ');
  const audioLine = [f.audio.label, ...(f.audio.subs || [])].filter(Boolean).join(' • ');
  const cleanTitle = `${idx === 0 ? '⭐ Odporúčané\n' : ''}${f.name}\n${info}\n${audioLine}`;

  const obj = {
    name: `FastShare ${f.audio.lang && f.audio.lang !== 'any' ? f.audio.lang : ''}`.trim(),
    title: cleanTitle,
    description: `${f.name}\n${info}\n${audioLine}`,
    url: streamUrl,
    externalUrl: streamUrl
  };

  // Nuvio can be stricter than Stremio. Keep behaviorHints small and safe.
  obj.behaviorHints = {
    bingeGroup: `fastshare-${f.quality || 'auto'}-${f.audio.lang || 'any'}`
  };

  return obj;
}

async function buildStreamResponse(req, debug = false) {
  const creds = getCredentials(req);
  const auth = await login(creds);
  const type = req.params.type, id = req.params.id;
  const meta = await getMeta(type, id);
  if (!auth.ok) return debug ? { ok: true, version: VERSION, auth, streams: [] } : { streams: [] };
  const terms = termsFor(meta);
  const searches = [];
  let all = [];
  for (const term of terms) {
    const r = await searchFastshare(term, auth.hash);
    searches.push({ term: r.term, status: r.status, resultCount: r.resultCount, apiUrl: r.apiUrl, firstFiles: r.files.slice(0,3) });
    all.push(...r.files);
  }
  const scored = all.map(f => scoreFile(f, meta, type)).filter(Boolean).filter(f => f.score > (type === 'series' ? 20 : 50));
  const sorted = dedupe(scored).sort((a,b) => b.score - a.score).slice(0, MAX_STREAMS);
  const streams = sorted.map((f, i) => streamObj(f, auth.hash, i === 0));
  if (!debug) return { streams };
  return { ok: true, version: VERSION, request: { type, id }, meta, terms, auth: { ok: true, source: auth.source, hasHash: true }, search: searches, streamCount: streams.length, files: sorted, streams };
}

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));
app.get('/manifest.json', (req, res) => res.json(manifest(null)));
app.get('/:config/manifest.json', (req, res) => res.json(manifest(req.params.config)));

app.get('/configure', (req, res) => {
  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
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
<h1>FastShare Stremio Addon</h1>
<div class="box">
<p>Zadaj FastShare prihlasenie. Údaje sa uložia iba do vygenerovanej manifest URL.</p>
<input id="fsUser" name="username" placeholder="FastShare username" autocomplete="username">
<input id="fsPass" name="password" placeholder="FastShare password" type="password" autocomplete="current-password">
<button type="button" id="genBtn">Vygenerovať URL</button>
<p class="warn">URL neposielaj verejne, obsahuje zakódované prihlasovanie.</p>
<div id="out"><p>Zatiaľ nie je vygenerovaná žiadna URL.</p></div>
</div>
<div class="box">
<p><b>Fallback bez JavaScriptu:</b> keď tlačidlo nefunguje, použi toto tlačidlo. Presmeruje ťa priamo na konfigurovaný manifest.</p>
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
  const token = b64urlEncode({ username: req.body.username || '', password: req.body.password || '' });
  res.redirect(`/${token}/manifest.json`);
});

app.get('/debug/login', async (req, res) => res.json({ ok: true, version: VERSION, login: await login(getCredentials(req)) }));
app.get('/:config/debug/login', async (req, res) => res.json({ ok: true, version: VERSION, login: await login(getCredentials(req)) }));
app.get('/debug/search', async (req, res) => { const auth = await login(getCredentials(req)); if (!auth.ok) return res.json({ ok: true, version: VERSION, auth, resultCount: 0, files: [] }); const r = await searchFastshare(req.query.term || 'avatar', auth.hash); res.json({ ok: true, version: VERSION, auth: { ok: true, hasHash: true }, ...r }); });
app.get('/:config/debug/search', async (req, res) => { const auth = await login(getCredentials(req)); if (!auth.ok) return res.json({ ok: true, version: VERSION, auth, resultCount: 0, files: [] }); const r = await searchFastshare(req.query.term || 'avatar', auth.hash); res.json({ ok: true, version: VERSION, auth: { ok: true, hasHash: true }, ...r }); });


function patchSeriesParams(req) {
  // Nuvio can call series streams as /stream/series/tt1234567/1/2.json
  // while Stremio usually calls /stream/series/tt1234567:1:2.json.
  // This helper normalizes both into the Stremio-style id before buildStreamResponse().
  if (req.params && req.params.type === 'series' && req.params.imdb && req.params.season && req.params.episode) {
    req.params.id = `${req.params.imdb}:${req.params.season}:${String(req.params.episode).replace(/\.json$/i, '')}`;
  }
  return req;
}


// Nuvio fallback route: same streams, but strips behaviorHints and keeps description/externalUrl.
async function nuvioStreamResponse(req, res, debug = false) {
  try {
    const payload = await buildStreamResponse(req, debug);
    if (payload && Array.isArray(payload.streams)) {
      payload.streams = payload.streams.map(s => {
        const x = { ...s };
        delete x.behaviorHints;
        if (!x.description) x.description = x.title || x.name || '';
        if (!x.externalUrl && x.url) x.externalUrl = x.url;
        return x;
      });
    }
    res.json(payload);
  } catch (e) {
    res.json(debug ? { ok:false, version: VERSION, error: String(e.stack || e) } : { streams: [] });
  }
}

app.get('/nuvio/stream/:type/:id.json', async (req, res) => nuvioStreamResponse(req, res, false));
app.get('/:config/nuvio/stream/:type/:id.json', async (req, res) => nuvioStreamResponse(req, res, false));
app.get('/nuvio/stream/:type/:imdb/:season/:episode.json', async (req, res) => { patchSeriesParams(req); return nuvioStreamResponse(req, res, false); });
app.get('/:config/nuvio/stream/:type/:imdb/:season/:episode.json', async (req, res) => { patchSeriesParams(req); return nuvioStreamResponse(req, res, false); });
app.get('/nuvio/debug/stream/:type/:id.json', async (req, res) => nuvioStreamResponse(req, res, true));
app.get('/:config/nuvio/debug/stream/:type/:id.json', async (req, res) => nuvioStreamResponse(req, res, true));

// Nuvio-compatible series routes:
// /stream/series/tt1234567/1/2.json
// /<config>/stream/series/tt1234567/1/2.json
app.get('/stream/:type/:imdb/:season/:episode.json', async (req, res) => { try { patchSeriesParams(req); res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/:config/stream/:type/:imdb/:season/:episode.json', async (req, res) => { try { patchSeriesParams(req); res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/debug/stream/:type/:imdb/:season/:episode.json', async (req, res) => { try { patchSeriesParams(req); res.json(await buildStreamResponse(req, true)); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });
app.get('/:config/debug/stream/:type/:imdb/:season/:episode.json', async (req, res) => { try { patchSeriesParams(req); res.json(await buildStreamResponse(req, true)); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });

// Original Stremio routes:
// /stream/series/tt1234567:1:2.json
// /<config>/stream/series/tt1234567:1:2.json
app.get('/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/:config/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/debug/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, true)); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });
app.get('/:config/debug/stream/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, true)); } catch (e) { res.status(500).json({ ok:false, version: VERSION, error: String(e.stack || e) }); } });

// Extra plural aliases for clients that call /streams instead of /stream.
app.get('/streams/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/:config/streams/:type/:id.json', async (req, res) => { try { res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/streams/:type/:imdb/:season/:episode.json', async (req, res) => { try { patchSeriesParams(req); res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });
app.get('/:config/streams/:type/:imdb/:season/:episode.json', async (req, res) => { try { patchSeriesParams(req); res.json(await buildStreamResponse(req, false)); } catch (e) { res.json({ streams: [] }); } });

app.listen(PORT, () => console.log(`FastShare Stremio addon v${VERSION} on ${PORT}`));
