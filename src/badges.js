'use strict';

const {
  VERSION,
  HTTP_TIMEOUT_MS,
  NARD_BADGES_URL,
  LEGACY_NUVIO_BADGES_URL,
  NUVIO_BASE_BADGES_URL,
  NUVIO_BADGES_CACHE_TTL_MS
} = require('./config');
const { normalize, fetchJson } = require('./utils');
const { detectAudio, detectQuality } = require('./ranking');

let nuvioBaseBadgesCache = null;

function detectBadgeTags(name, file = {}) {
  const raw = String(name || '');
  const tags = [];
  const add = tag => { if (tag && !tags.includes(tag)) tags.push(tag); };

  if (/\bremux\b/i.test(raw)) add('REMUX');
  else if (/\b(?:blu[ ._-]?ray|bdremux|bdrip|brrip)\b/i.test(raw)) add('BluRay');
  else if (/\b(?:web[ ._-]?dl|webdl|web[ ._-]?rip|webrip)\b/i.test(raw)) add('WEB-DL');
  else if (/\bhdtv\b/i.test(raw)) add('HDTV');

  const quality = file.quality || detectQuality(raw);
  if (quality === '4K') add('2160p');
  else if (quality === '1080p') add('1080p');
  else if (quality === '720p') add('720p');
  else if (quality === '480p') add('480p');

  if (/\bimax[ ._-]?enhanced\b/i.test(raw)) add('IMAX Enhanced');
  else if (/\bimax\b/i.test(raw)) add('IMAX');
  if (/\b(?:dovi|dolby[ ._-]?vision|dv)\b/i.test(raw)) add('DV');
  if (/\bhdr[ ._-]?10[ ._-]?(?:\+|plus|p)\b/i.test(raw)) add('HDR10+');
  else if (/\bhdr[ ._-]?10\b/i.test(raw)) add('HDR10');
  else if (/\bhdr\b/i.test(raw)) add('HDR');

  if (/\b(?:av1|av01)\b/i.test(raw)) add('AV1');
  else if (/\b(?:hevc|h[ ._-]?265|x265)\b/i.test(raw)) add('HEVC');
  else if (/\b(?:avc|h[ ._-]?264|x264)\b/i.test(raw)) add('AVC');

  if (/\batmos\b/i.test(raw)) add('Atmos');
  if (/\btrue[ ._-]?hd\b/i.test(raw)) add('TrueHD');
  if (/\bdts[ ._:-]?x\b/i.test(raw)) add('DTS:X');
  else if (/\bdts[ ._-]?(?:hd[ ._-]?)?ma\b/i.test(raw)) add('DTS-HD MA');
  else if (/\bdts[ ._-]?hd\b/i.test(raw)) add('DTS-HD');
  else if (/\bdts\b/i.test(raw)) add('DTS');
  if (/\b(?:ddp(?:[ ._-]?[257][ .][01])?|dd\+|e[ ._-]?ac[ ._-]?3|eac3)\b/i.test(raw)) add('DD+');
  else if (/\b(?:ac[ ._-]?3|dd(?:2[ .]0|5[ .]1|7[ .]1)?)\b/i.test(raw)) add('DD');
  if (/\b(?:aac|aac2[ .]0|aac5[ .]1)\b/i.test(raw)) add('AAC');

  const channel = raw.match(/(?:^|[^0-9])([2-8])[ .]([01])(?:[^0-9]|$)/);
  if (channel) add(`${channel[1]}.${channel[2]}`);

  const audio = file.audio || detectAudio(raw);
  const key = String(audio.key || '');
  const audioLabel = String(audio.label || '');
  const verifiedAudio = audio.verifiedAudio === true;
  // Keep machine-readable AUDIO tokens for Nard/Nuvio filters, while adding
  // user-visible country flags only when the audio language is verified.
  if (verifiedAudio && key.includes('CZ')) { add('🇨🇿 CZ'); add('CZ AUDIO'); }
  if (verifiedAudio && key.includes('SK')) { add('🇸🇰 SK'); add('SK AUDIO'); }
  if (verifiedAudio && key.includes('EN')) { add('🇬🇧 EN'); add('EN AUDIO'); }
  if (verifiedAudio && key === 'multi') { add('🌐 MULTI'); add('MULTI AUDIO'); }
  if (key === 'dub' || /dabing|dubbing|dubbed/i.test(audioLabel)) add('DABING');
  if (/^CZ titulky/i.test(audioLabel) || (audio.subs || []).some(x => /^CZ /i.test(x))) add('CZ SUBS');
  if (/^SK titulky/i.test(audioLabel) || (audio.subs || []).some(x => /^SK /i.test(x))) add('SK SUBS');

  if (/\b10[ ._-]?bit\b|\bhi10p\b/i.test(raw)) add('10bit');
  if (/\bhybrid\b/i.test(raw)) add('HYBRID');
  if (/\b(?:mkv|matroska)\b/i.test(raw) || String(file.ext || '').toUpperCase() === 'MKV') add('MKV');
  else if (/\bmp4\b/i.test(raw) || String(file.ext || '').toUpperCase() === 'MP4') add('MP4');

  return tags;
}

function nuvioBadgeFilter(baseUrl, {
  id,
  name,
  pattern,
  image,
  groupId = 'fastshare-extra',
  tagColor = '#00000000',
  textColor = '#FFFFFF',
  borderColor = '#FFFFFFFF',
  tagStyle = 'filled and bordered'
}) {
  return {
    borderColor,
    groupId,
    id,
    imageURL: `${baseUrl}/badges/${image}`,
    isEnabled: true,
    name,
    pattern,
    tagColor,
    tagStyle,
    textColor,
    type: 'filter'
  };
}

function buildExtraNuvioFilters(baseUrl) {
  const f = data => nuvioBadgeFilter(baseUrl, data);
  return [
    f({ id: 'fs-nard-recommended', name: 'Odporúčané', pattern: '(?i)\\bOdporúčané\\b', image: 'nard-rec.png', groupId: 'fs-status', borderColor: '#FFFFC107' }),
    f({ id: 'fs-nard-dabing', name: 'Dabing', pattern: '(?i)\\bDABING\\b', image: 'nard-dub.png', groupId: 'fs-language' }),
    f({ id: 'fs-nard-subs-cz', name: 'CZ titulky', pattern: '(?i)\\bCZ\\s+SUBS\\b', image: 'nard-czs.png', groupId: 'fs-subs' }),
    f({ id: 'fs-nard-subs-sk', name: 'SK titulky', pattern: '(?i)\\bSK\\s+SUBS\\b', image: 'nard-sks.png', groupId: 'fs-subs' }),
    f({ id: 'fs-nard-res-480', name: '480p', pattern: '(?i)\\b480p\\b', image: 'nard-480p.png', groupId: 'gr', borderColor: '#FF858283' }),
    f({ id: 'fs-nard-container-mkv', name: 'MKV', pattern: '(?i)\\bMKV\\b', image: 'nard-mkv.png', groupId: 'fs-container' }),
    f({ id: 'fs-nard-container-mp4', name: 'MP4', pattern: '(?i)\\bMP4\\b', image: 'nard-mp4.png', groupId: 'fs-container' })
  ];
}

function adaptNardBadgeFilters(filters) {
  const languagePatterns = new Map([
    ['f1', '(?i)\\b(?:CZ|CZE|CES|CESKY|CESTINA|CZECH)\\s+AUDIO\\b'],
    ['f2', '(?i)\\b(?:SK|SVK|SLOVAK|SLOVENCINA|SLOVENSKY)\\s+AUDIO\\b'],
    ['l-en', '(?i)\\b(?:EN|ENG|ENGLISH)\\s+AUDIO\\b'],
    ['l-mu', '(?i)\\b(?:MULTI|MUL)\\s+AUDIO\\b']
  ]);
  const languageNames = new Map([
    ['CZE', languagePatterns.get('f1')],
    ['SVK', languagePatterns.get('f2')],
    ['ENG', languagePatterns.get('l-en')],
    ['MUL', languagePatterns.get('l-mu')]
  ]);
  return (filters || []).map(item => {
    if (!item || typeof item !== 'object') return item;
    const id = String(item.id || '').toLowerCase();
    const name = String(item.name || '').toUpperCase();
    const pattern = languagePatterns.get(id) || languageNames.get(name);
    return pattern ? { ...item, pattern } : item;
  });
}

async function fetchNuvioPreset(url) {
  const value = await fetchJson(url, {
    headers: { 'User-Agent': `FastShare-Stremio/${VERSION}` }
  }, Math.min(HTTP_TIMEOUT_MS, 7000));
  if (!value || !Array.isArray(value.filters)) throw new Error('Invalid Nuvio badge preset');
  return { ...value, filters: adaptNardBadgeFilters(value.filters) };
}

async function getBaseNuvioBadgePreset() {
  if (nuvioBaseBadgesCache && Date.now() < nuvioBaseBadgesCache.expiresAt) return nuvioBaseBadgesCache.value;
  const urls = [NUVIO_BASE_BADGES_URL];
  if (NUVIO_BASE_BADGES_URL !== LEGACY_NUVIO_BADGES_URL) urls.push(LEGACY_NUVIO_BADGES_URL);
  let lastError;
  for (const url of urls) {
    try {
      const value = await fetchNuvioPreset(url);
      const source = url === NARD_BADGES_URL ? 'nard' : (url === LEGACY_NUVIO_BADGES_URL ? 'legacy' : 'custom');
      const cached = { ...value, fastsharePresetSource: source };
      nuvioBaseBadgesCache = { value: cached, expiresAt: Date.now() + NUVIO_BADGES_CACHE_TTL_MS };
      return cached;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to load Nuvio badge preset');
}

function mergeNuvioBadgeFilters(baseFilters, extraFilters) {
  const out = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (const item of [...(baseFilters || []), ...(extraFilters || [])]) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    if ((id && seenIds.has(id)) || (name && seenNames.has(name))) continue;
    if (id) seenIds.add(id);
    if (name) seenNames.add(name);
    out.push(item);
  }
  return out;
}

function clearNuvioBadgeCache() {
  nuvioBaseBadgesCache = null;
}

module.exports = {
  detectBadgeTags,
  buildExtraNuvioFilters,
  adaptNardBadgeFilters,
  fetchNuvioPreset,
  getBaseNuvioBadgePreset,
  mergeNuvioBadgeFilters,
  clearNuvioBadgeCache,
  NARD_BADGES_URL
};
