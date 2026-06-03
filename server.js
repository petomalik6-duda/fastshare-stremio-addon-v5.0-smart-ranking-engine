const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const VERSION = '5.1.0-beta';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const FASTSHARE_API = process.env.FASTSHARE_API || 'https://fastshare.cz/api/api_kodi.php';
const USERNAME = process.env.FASTSHARE_USERNAME || '';
const PASSWORD = process.env.FASTSHARE_PASSWORD || '';
const PLAYBACK_MODE = process.env.FASTSHARE_PLAYBACK_MODE || 'direct_stream';
const MAX_RESULTS = parseInt(process.env.FASTSHARE_MAX_RESULTS || '12', 10);
const ADULT = process.env.FASTSHARE_ADULT || '0';
let authCache = { hash: process.env.FASTSHARE_HASH || '', ts: process.env.FASTSHARE_HASH ? Date.now() : 0 };

const manifest = {
  id: 'community.fastshare.kodiapi.streams.v51beta',
  version: VERSION,
  name: 'FastShare Kodi API',
  description: 'FastShare stream addon v5.1 Smart Matching Fix: stronger year/sequel filtering, multi-audio detection, CZ > SK > EN ranking.',
  logo: 'https://www.stremio.com/website/stremio-logo-small.png',
  resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: false, configurationRequired: false }
};

function safeJson(res, obj) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify(obj));
}

async function login(force = false) {
  if (!force && authCache.hash && Date.now() - authCache.ts < 6 * 60 * 60 * 1000) {
    return { ok: true, hash: authCache.hash, source: 'cache-or-env' };
  }
  if (!USERNAME || !PASSWORD) return { ok: false, error: 'Missing FASTSHARE_USERNAME/FASTSHARE_PASSWORD or FASTSHARE_HASH' };
  const url = `${FASTSHARE_API}?process=login&login=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Kodi/21 FastShare Stremio Addon/5.1' } });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, status: r.status, error: 'Invalid JSON', preview: text.slice(0, 400) }; }
  const hash = json?.user?.hash || json?.hash || json?.data?.hash;
  if (!hash) return { ok: false, status: r.status, error: 'Hash not found', raw: json };
  authCache = { hash, ts: Date.now() };
  return { ok: true, hash, source: 'login', status: r.status };
}

function parseStremioId(type, id) {
  const raw = String(id || '');
  const parts = raw.split(':');
  const baseId = parts[0] || raw;
  const season = type === 'series' && parts.length >= 3 ? Number(parts[1]) : null;
  const episode = type === 'series' && parts.length >= 3 ? Number(parts[2]) : null;
  return { raw, baseId, season, episode, hasEpisode: Number.isFinite(season) && Number.isFinite(episode) };
}

function slugToTitle(slug) {
  const known = {
    jackryan: 'Jack Ryan',
    'jack-ryan': 'Jack Ryan',
    tomclancysjackryan: "Tom Clancy's Jack Ryan",
    'tom-clancys-jack-ryan': "Tom Clancy's Jack Ryan"
  };
  const key = String(slug || '').toLowerCase();
  if (known[key]) return known[key];
  return String(slug || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

async function getMeta(type, id) {
  const parsed = parseStremioId(type, id);
  const lookupId = parsed.baseId || id;
  try {
    if (lookupId && lookupId.startsWith('tt')) {
      const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${lookupId}.json`);
      const j = await r.json();
      const m = j.meta || {};
      return {
        type, imdbId: lookupId, stremioId: id,
        title: m.name || m.title || lookupId,
        year: String(m.year || m.releaseInfo || '').match(/\d{4}/)?.[0] || '',
        season: parsed.season, episode: parsed.episode, raw: m
      };
    }
  } catch {}
  return { type, imdbId: lookupId, stremioId: id, title: slugToTitle(lookupId), year: '', season: parsed.season, episode: parsed.episode, raw: {} };
}

function normalizeTitle(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&amp;/g, '&').replace(/[:._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function getRequestedEpisode(id) {
  const parts = String(id || '').split(':');
  if (parts.length >= 3) return { season: Number(parts[1]), episode: Number(parts[2]) };
  return null;
}

function buildTerms(meta, type = 'movie', id = '') {
  const title = meta.title || meta.imdbId;
  const simple = normalizeTitle(title);
  if (type === 'series') {
    const ep = getRequestedEpisode(id) || (meta.season && meta.episode ? { season: meta.season, episode: meta.episode } : null);
    const se = ep ? String(ep.season).padStart(2, '0') : '';
    const ee = ep ? String(ep.episode).padStart(2, '0') : '';
    return [...new Set([
      ep ? `${simple} S${se}E${ee}` : '',
      ep ? `${simple} ${ep.season}x${ep.episode}` : '',
      ep ? `${simple} ${se}x${ee}` : '',
      simple,
      normalizeTitle(meta.imdbId || '').replace(/\s+/g, '')
    ].filter(Boolean))].slice(0, 8);
  }
  const noSubtitle = simple.split(/\b(the way of water|cesta vody|ohen a popel|fire and ash)\b/i)[0].trim();
  return [...new Set([title, meta.year ? `${title} ${meta.year}` : '', simple, noSubtitle, simple.split(' ')[0]].filter(Boolean))].slice(0, 6);
}

async function searchFastShare(term) {
  const auth = await login();
  if (!auth.ok) return { auth, status: 0, files: [], resultCount: 0 };
  const attempts = [
    `${FASTSHARE_API}?process=search&pagination=200&term=${encodeURIComponent(term)}&adult=${ADULT}`,
    `${FASTSHARE_API}?process=search&kodi=1&pagination=200&term=${encodeURIComponent(term)}&adult=${ADULT}`
  ];
  let best = { auth, status: 0, files: [], resultCount: 0, attempts: [] };
  for (const apiUrl of attempts) {
    const r = await fetch(apiUrl, { headers: { 'User-Agent': 'Kodi/21 FastShare Stremio Addon/5.1', 'Cookie': `FASTSHARE=${auth.hash}` } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    const filesRaw = json?.search?.file || json?.search?.files || json?.file || json?.files || [];
    const arr = Array.isArray(filesRaw) ? filesRaw : (filesRaw ? [filesRaw] : []);
    const files = arr.map(mapFile).filter(f => f && f.url && f.name && isVideo(`${f.name} ${f.url}`));
    const attempt = { apiUrl, status: r.status, jsonKeys: json ? Object.keys(json) : [], resultCount: files.length, firstFiles: files.slice(0, 3) };
    best.attempts.push(attempt);
    if (files.length > best.files.length) best = { ...best, status: r.status, files, resultCount: files.length, apiUrl, rawPreview: text.slice(0, 800), attempts: best.attempts };
  }
  return best;
}

function mapFile(raw) {
  const name = raw.filename || raw.name || raw.title || '';
  const url = raw.download_url || raw.url || raw.download || '';
  const size = raw?.data?.value || raw.size || raw.filesize || '';
  return { id: raw.id || extractId(url), name, size, url, image: raw.thumbnail || raw.image || '', duration: raw?.duration?.value || raw.duration || '', durationText: raw.duration_f || '', resolution: raw.resolution || '', raw };
}
function extractId(url) { return String(url || '').match(/[?&]id=(\d+)/)?.[1] || ''; }
function isVideo(x) { return /\.(mp4|mkv|avi|mov|m4v|webm|ts)(\?|$|\s)/i.test(x || '') || /download\.php\?id=/i.test(x || ''); }
function bytesToSize(bytes) { const n = Number(bytes); if (!n || Number.isNaN(n)) return ''; const units = ['B','KB','MB','GB','TB']; let v=n,i=0; while(v>=1024&&i<units.length-1){v/=1024;i++;} return `${v>=10||i<2?v.toFixed(0):v.toFixed(1)} ${units[i]}`; }
function detectExt(name) { const m = String(name || '').split(/[?#]/)[0].trim().match(/\.([a-z0-9]{2,5})$/i); const ext = m ? m[1].toUpperCase() : ''; return ['MKV','MP4','AVI','MOV','M4V','WEBM','TS'].includes(ext) ? ext : ''; }
function detectQuality(name) { const s=String(name).toLowerCase(); if(/2160p|4k|uhd|ultrahd/.test(s)) return '4K'; if(/1440p/.test(s)) return '1440p'; if(/1080p|fhd|fullhd/.test(s)) return '1080p'; if(/720p|\bhd\b/.test(s)) return '720p'; if(/480p|\bsd\b/.test(s)) return '480p'; return ''; }
function detectBad(name) { const s=` ${String(name).toLowerCase()} `; return /\b(cam|camrip|hdcam|ts|telesync|tc|telecine|scr|screener|workprint|wp)\b/.test(s) ? 'CAM/TS' : ''; }

function detectLanguageInfo(name) {
  const original = String(name || '').replace(/&amp;/g, '&');
  const s = ` ${normalizeTitle(original).toLowerCase()} `;

  // Normalize common language aliases used in FastShare filenames.
  // Important: plain "cz" is NOT enough for CZ dabing. It may mean subtitles or just uploader tag.
  const czToken = String.raw`(?:cz|cs|cze|ces|czech|cesky|ceske|cesky)`;
  const skToken = String.raw`(?:sk|svk|slk|slovak|slovensky|slovenske)`;
  const enToken = String.raw`(?:en|eng|english|anglicky|anglicke)`;

  const hasCzSubs = new RegExp(`\b${czToken}\s*(?:tit|title|titles|sub|subs|subtitle|subtitles|forced|titulky)\b|\b(?:tit|title|subs|subtitles|titulky)\s*${czToken}\b`, 'i').test(s);
  const hasSkSubs = new RegExp(`\b${skToken}\s*(?:tit|title|titles|sub|subs|subtitle|subtitles|forced|titulky)\b|\b(?:tit|title|subs|subtitles|titulky)\s*${skToken}\b`, 'i').test(s);
  const hasEnSubs = new RegExp(`\b${enToken}\s*(?:tit|title|titles|sub|subs|subtitle|subtitles)\b|\b(?:tit|title|subs|subtitles)\s*${enToken}\b`, 'i').test(s);

  const hasCzDub = new RegExp(`\b${czToken}\s*(?:dab|dub|dabing|audio|zvuk)\b|\b(?:dab|dub|dabing|audio|zvuk)\s*${czToken}\b`, 'i').test(s);
  const hasSkDub = new RegExp(`\b${skToken}\s*(?:dab|dub|dabing|audio|zvuk)\b|\b(?:dab|dub|dabing|audio|zvuk)\s*${skToken}\b`, 'i').test(s);
  const hasEnAudio = new RegExp(`\b${enToken}\s*(?:dab|dub|dabing|audio|zvuk)\b|\b(?:dab|dub|dabing|audio|zvuk)\s*${enToken}\b|\boriginal\s*(?:audio|zvuk)?\b|\borig\b`, 'i').test(s);

  // Multi / dual audio patterns: CZ EN, ENG+CZE, Cs+En-Dab+Tit, audio CZE-ENG-SPA-HUN, etc.
  const hasCzMarker = new RegExp(`\b${czToken}\b`, 'i').test(s);
  const hasSkMarker = new RegExp(`\b${skToken}\b`, 'i').test(s);
  const hasEnMarker = new RegExp(`\b${enToken}\b`, 'i').test(s);
  const hasAudioContext = /\b(audio|dab|dub|dabing|zvuk|5\.1|6ch|ac3|dts|remux|dual|multi)\b/i.test(s);
  const hasMulti = /(multi|dual|dual\s*audio|dualaudio|2audio|multi\s*audio|cz\+sk|sk\+cz|cz\s*[,;+\-]\s*en|en\s*[,;+\-]\s*cz|cze\s*[,;+\-]\s*eng|eng\s*[,;+\-]\s*cze|cs\s*[,;+\-]\s*en|en\s*[,;+\-]\s*cs)/i.test(s) || (hasAudioContext && ((hasCzMarker && hasEnMarker) || (hasSkMarker && hasEnMarker) || (hasCzMarker && hasSkMarker)));

  const weakCz = !hasCzSubs && !hasCzDub && hasCzMarker;
  const weakSk = !hasSkSubs && !hasSkDub && hasSkMarker;
  const weakEn = !hasEnSubs && !hasEnAudio && hasEnMarker;

  const labels = [];
  if (hasMulti) {
    if (hasCzMarker && hasSkMarker && !hasEnMarker) labels.push('CZ/SK Dabing');
    else if (hasCzMarker && hasEnMarker) labels.push('CZ/EN Audio');
    else if (hasSkMarker && hasEnMarker) labels.push('SK/EN Audio');
    else labels.push('Multi Audio');
  } else {
    if (hasCzDub) labels.push('CZ Dabing');
    if (hasSkDub) labels.push('SK Dabing');
    if (hasEnAudio) labels.push('EN Audio');
  }

  const subLabels = [];
  if (hasCzSubs) subLabels.push('CZ titulky');
  if (hasSkSubs) subLabels.push('SK titulky');
  if (hasEnSubs) subLabels.push('EN titulky');

  let language = '';
  if (hasMulti) {
    if (hasCzMarker && hasSkMarker && !hasEnMarker) language = 'CZ/SK';
    else if (hasCzMarker && hasEnMarker) language = 'CZ/EN';
    else if (hasSkMarker && hasEnMarker) language = 'SK/EN';
    else language = 'MULTI';
  } else if (hasCzDub) language = 'CZ';
  else if (hasSkDub) language = 'SK';
  else if (hasEnAudio) language = 'EN';
  else if (weakCz) language = 'CZ?';
  else if (weakSk) language = 'SK?';
  else if (weakEn) language = 'EN?';

  return { language, label: labels.join(' + '), subtitles: subLabels.join(' + '), hasCzDub, hasSkDub, hasEnAudio, hasMulti, hasCzSubs, hasSkSubs, hasEnSubs, weakCz, weakSk, weakEn, hasCzMarker, hasSkMarker, hasEnMarker };
}

function isSeriesLikeName(name) { return /\b(s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d+|epizod|episode|diel|serie|seria)\b/i.test(String(name || '')); }
function containsEpisode(name, ep) { if (!ep) return false; const s=String(name||'').toLowerCase(); const se=String(ep.season).padStart(2,'0'); const ee=String(ep.episode).padStart(2,'0'); return [new RegExp(`s0?${ep.season}e0?${ep.episode}\\b`,'i'), new RegExp(`\\b0?${ep.season}x0?${ep.episode}\\b`,'i'), new RegExp(`s${se}e${ee}`,'i')].some(r=>r.test(s)); }
function cleanTitleTokens(title) { return normalizeTitle(title).toLowerCase().replace(/\b(the|a|an|and|of|to|in|na|o)\b/g,' ').split(' ').map(x=>x.trim()).filter(x=>x.length>2); }
function hasDifferentYear(name, wantedYear) { if (!wantedYear) return false; const years=[...String(name).matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m=>m[1]); return years.length>0 && !years.includes(String(wantedYear)); }
function hasSequelMismatch(name, meta) {
  const title = normalizeTitle(meta.title || '').toLowerCase();
  const s = normalizeTitle(name || '').toLowerCase();
  if (!title) return false;
  // Avatar (2009) should not match Avatar 2 / Way of Water / Fire and Ash.
  // Generic rule: requested title followed by a sequel number or known subtitle is suspicious unless it is explicitly the requested title.
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\b${escaped}\s*(?:2|ii|3|iii|4|iv)\b`, 'i').test(s) && !/\bavatar\s*1\b/i.test(s)) return true;
  if (/\b(the way of water|cesta vody|fire and ash|ohen a popel|oheň a popel|last airbender|legenda o aangovi)\b/i.test(s) && !/way of water|cesta vody|fire and ash|ohen a popel|oheň a popel/i.test(title)) return true;
  return false;
}


function parseRuntimeMinutes(raw) {
  if (!raw) return 0;
  const m = String(raw).match(/(\d{1,3})\s*min/i);
  return m ? Number(m[1]) : 0;
}
function fileDurationMinutes(file) {
  const seconds = Number(file.duration || file?.raw?.duration?.value || 0);
  if (seconds > 0) return Math.round(seconds / 60);
  const text = String(file.durationText || file?.raw?.duration_f || '');
  const m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  if (m[3]) return Number(m[1]) * 60 + Number(m[2]) + Math.round(Number(m[3]) / 60);
  return Number(m[1]) * 60 + Math.round(Number(m[2]) / 60);
}
function runtimeScore(file, meta, type) {
  const minutes = fileDurationMinutes(file);
  if (!minutes) return { score: 0, reason: '' };
  if (type === 'series') {
    if (minutes >= 15 && minutes <= 75) return { score: 15, reason: 'series runtime +15' };
    if (minutes > 100) return { score: -35, reason: 'movie runtime in series -35' };
    return { score: 0, reason: '' };
  }
  const target = parseRuntimeMinutes(meta?.raw?.runtime);
  if (target) {
    const diff = Math.abs(minutes - target);
    if (diff <= 8) return { score: 25, reason: 'runtime exact +25' };
    if (diff <= 20) return { score: 15, reason: 'runtime close +15' };
    if (diff >= 60) return { score: -50, reason: 'runtime far -50' };
    return { score: 0, reason: '' };
  }
  if (minutes >= 70) return { score: 8, reason: 'movie runtime +8' };
  if (minutes > 0 && minutes < 20) return { score: -60, reason: 'too short -60' };
  return { score: 0, reason: '' };
}

function sizeScore(bytes) {
  const size = Number(bytes || 0);
  if (!size) return { score: 0, reason: '' };
  const gb = size / 1024 / 1024 / 1024;
  if (gb >= 15) return { score: 25, reason: 'size >15GB +25' };
  if (gb >= 10) return { score: 20, reason: 'size >10GB +20' };
  if (gb >= 6) return { score: 15, reason: 'size >6GB +15' };
  if (gb >= 3) return { score: 10, reason: 'size >3GB +10' };
  if (gb >= 1) return { score: 5, reason: 'size >1GB +5' };
  if (gb < 0.3) return { score: -25, reason: 'tiny file -25' };
  return { score: 0, reason: '' };
}

function smartScoreFile(file, meta, type, id) {
  const original=file.name||''; const name=normalizeTitle(original).toLowerCase(); const title=normalizeTitle(meta.title).toLowerCase(); const year=String(meta.year||''); const ep=getRequestedEpisode(id);
  const lang=detectLanguageInfo(original); const quality=detectQuality(original); const ext=detectExt(original); const bad=detectBad(original);
  let score=0; const reasons=[];

  // Smart matching: title/year first, but language remains the dominant preference for similarly matched files.
  if (title && name.includes(title)) { score+=100; reasons.push('exact-title +100'); }
  else {
    const tokens=cleanTitleTokens(meta.title); let matched=0;
    for(const t of tokens) if(name.includes(t)) matched++;
    if(tokens.length){const pts=Math.round((matched/tokens.length)*60); score+=pts; reasons.push(`title-tokens +${pts}`);}
  }
  if (year && name.includes(year)) { score+=50; reasons.push('year +50'); }
  if (hasDifferentYear(original,year)) { score-=200; reasons.push('different-year -200'); }
  if (type==='movie' && hasSequelMismatch(original, meta)) { score-=220; reasons.push('sequel-mismatch -220'); }

  if (type==='movie' && isSeriesLikeName(original)) { score-=120; reasons.push('series-like movie penalty -120'); }
  if (type==='series') {
    if(ep && containsEpisode(original,ep)){score+=140; reasons.push('episode match +140');}
    else if(ep && isSeriesLikeName(original)){score-=80; reasons.push('wrong/unknown episode -80');}
  }

  // Audio/subtitle engine. CZ > SK > EN. Subtitles are extra, not audio.
  if (lang.hasCzDub) { score+=100; reasons.push('CZ dabing +100'); }
  if (lang.hasSkDub) { score+=80; reasons.push('SK dabing +80'); }
  if (lang.hasEnAudio) { score+=40; reasons.push('EN audio +40'); }
  if (lang.hasMulti) {
    if (lang.hasCzMarker) { score+=90; reasons.push('multi with CZ +90'); }
    else if (lang.hasSkMarker) { score+=70; reasons.push('multi with SK +70'); }
    else { score+=30; reasons.push('multi audio +30'); }
  }
  if (lang.hasCzSubs) { score+=15; reasons.push('CZ subtitles +15'); }
  if (lang.hasSkSubs) { score+=12; reasons.push('SK subtitles +12'); }
  if (lang.hasEnSubs) { score+=4; reasons.push('EN subtitles +4'); }
  if (!lang.hasCzDub && !lang.hasSkDub && !lang.hasEnAudio && (lang.weakCz || lang.weakSk || lang.weakEn)) { score+=8; reasons.push('weak language marker +8'); }

  if (quality==='4K') { score+=30; reasons.push('4K +30'); }
  else if (quality==='1080p') { score+=20; reasons.push('1080p +20'); }
  else if (quality==='720p') { score+=10; reasons.push('720p +10'); }

  if (ext==='MKV') { score+=10; reasons.push('MKV +10'); }
  else if (ext==='MP4') { score+=8; reasons.push('MP4 +8'); }
  else if (ext==='AVI') { score-=3; reasons.push('AVI -3'); }

  const ss = sizeScore(file.size); if (ss.score) { score += ss.score; reasons.push(ss.reason); }
  const rs = runtimeScore(file, meta, type); if (rs.score) { score += rs.score; reasons.push(rs.reason); }
  if (bad) { score-=100; reasons.push('bad quality -100'); }

  return { score, reasons };
}

function dedupeRankedFiles(files) {
  const seen=new Map();
  const containerRank = { MKV: 3, MP4: 2, M4V: 2, AVI: 1 };
  for(const f of files){
    const q=detectQuality(f.name)||'auto';
    const lang=detectLanguageInfo(f.name).language||'any';
    const ep = String(f.name).match(/\b(s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})\b/i)?.[1]?.toLowerCase() || '';
    let rough=normalizeTitle(f.name).toLowerCase()
      .replace(/&amp;/g,' ')
      .replace(/\b(2160p|1080p|720p|480p|4k|uhd|uhdr|fhd|fullhd|bdrip|bluray|webdl|webrip|hdrip|dvdrip)\b/g,' ')
      .replace(/\b(czdab|skdab|cz|sk|en|eng|czech|slovak|english|dabing|audio|title|tit|subs|subtitles|mkv|mp4|avi|x264|x265|h264|h265|hevc)\b/g,' ')
      .replace(/\b(19\d{2}|20\d{2})\b/g,' ')
      .replace(/\s+/g,' ').trim().slice(0,90);
    const key=`${rough}|${ep}|${q}|${lang}`;
    const old=seen.get(key);
    if(!old) { seen.set(key,f); continue; }
    const oldExt = detectExt(old.name); const newExt = detectExt(f.name);
    const oldSize = Number(old.size||0); const newSize = Number(f.size||0);
    const newBetter = (f.score > old.score) || (f.score === old.score && (containerRank[newExt]||0) > (containerRank[oldExt]||0)) || (f.score === old.score && newSize > oldSize);
    if(newBetter) seen.set(key,f);
  }
  return [...seen.values()];
}

function makeDirectStreamUrl(file, hash) {
  const ext=(detectExt(file.name)||'mp4').toLowerCase(); const id=file.id||extractId(file.url); if(!id) return file.url;
  const base=file.url.replace(/download\.php.*$/i,'download.php'); const filename=encodeURIComponent(file.name||`video.${ext}`);
  if (PLAYBACK_MODE==='direct_stream') return `${base}?id=${encodeURIComponent(id)}&stream=1&session=${encodeURIComponent(hash)}&${filename}`;
  return file.url;
}

function makeStream(file, hash) {
  const ext=detectExt(file.name); const quality=detectQuality(file.name); const langInfo=detectLanguageInfo(file.name); const lang=langInfo.language; const bad=detectBad(file.name); const size=bytesToSize(file.size); const duration=file.durationText || (file.duration ? `${Math.round(Number(file.duration)/60)} min` : '');
  const parts=[quality,size,ext,duration].filter(Boolean).join(' • ');
  const langLine=[langInfo.label, langInfo.subtitles, bad].filter(Boolean).join(' • ') || 'Audio neznáme';
  const rec = file.recommended ? '⭐ Odporúčané' : '';
  const title=[rec, file.name, parts, langLine].filter(Boolean).join('\n');
  const cleanLang = lang && !lang.endsWith('?') ? lang : '';
  return { name: cleanLang ? `FastShare ${cleanLang}` : 'FastShare', title, url: makeDirectStreamUrl(file, hash), behaviorHints: { bingeGroup: `fastshare-${quality||'auto'}-${cleanLang||'any'}` } };
}

async function buildStreams(type,id,debug=false){
  const meta=await getMeta(type,id); const terms=buildTerms(meta,type,id); const auth=await login(); const seen=new Set(); const all=[]; const searchDebug=[];
  for(const term of terms){
    const r=await searchFastShare(term); searchDebug.push({term,status:r.status,resultCount:r.resultCount,apiUrl:r.apiUrl,firstFiles:(r.files||[]).slice(0,3),auth:r.auth});
    for(const f of (r.files||[])){ const key=f.id||f.url||f.name; if(!seen.has(key)){seen.add(key); all.push(f);} }
    if(all.length>=MAX_RESULTS*3) break;
  }
  let rankedAll=all.map(f=>{const ss=smartScoreFile(f,meta,type,id); return {...f,score:ss.score,scoreReasons:ss.reasons};}).sort((a,b)=>b.score-a.score);
  if(type==='movie') {
    rankedAll = rankedAll.filter(f => !f.scoreReasons.includes('sequel-mismatch -220') && f.score > 80);
  }
  if(type==='series'){ const ep=getRequestedEpisode(id)||(meta.season&&meta.episode?{season:meta.season,episode:meta.episode}:null); if(ep){ const epMatches=rankedAll.filter(f=>containsEpisode(f.name,ep)); rankedAll=epMatches.length?epMatches:[]; } }
  const ranked=dedupeRankedFiles(rankedAll).slice(0,MAX_RESULTS).map((f,i)=>({...f,recommended:i===0})); const streams=auth.ok?ranked.map(f=>makeStream(f,auth.hash)):[];
  if(!debug) return { streams };
  return { ok:true, version:VERSION, request:{type,id}, meta, terms, auth:{ok:auth.ok,source:auth.source,hasHash:!!auth.hash}, search:searchDebug, streamCount:streams.length, files:ranked, streams };
}

app.get('/', (req,res)=>res.redirect('/manifest.json'));
app.get('/health', (req,res)=>safeJson(res,{ok:true,version:VERSION}));
app.get('/manifest.json', (req,res)=>safeJson(res,manifest));
app.get('/debug/login', async (req,res)=>safeJson(res,{ok:true,version:VERSION,login:await login()}));
app.get('/debug/search', async (req,res)=>{ const term=req.query.term||'avatar'; const r=await searchFastShare(term); safeJson(res,{ok:true,version:VERSION,term,...r,files:(r.files||[]).slice(0,20)}); });
app.get('/debug/stream/:type/:id.json', async (req,res)=>{ try{ safeJson(res,await buildStreams(req.params.type,req.params.id,true)); } catch(e){ safeJson(res,{ok:false,version:VERSION,error:String(e.stack||e)}); } });
app.get('/stream/:type/:id.json', async (req,res)=>{ try{ safeJson(res,await buildStreams(req.params.type,req.params.id,false)); } catch(e){ safeJson(res,{streams:[]}); } });

const port=process.env.PORT||10000;
app.listen(port,()=>console.log(`FastShare Stremio addon v${VERSION} listening on ${port}`));
