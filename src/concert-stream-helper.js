'use strict';

const { login: fastshareLogin, searchFastshare, streamUrl: fastshareStreamUrl } = require('./fastshare');
const { login: webshareLogin, searchWebshare, streamUrl: webshareStreamUrl } = require('./webshare');
const { mapWithConcurrency, normalize } = require('./utils');

function decodeConcertId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('concert:')) return '';
  try { return Buffer.from(raw.slice(8), 'base64url').toString('utf8'); } catch { return ''; }
}

function cleanQuery(title) {
  return String(title || '')
    .replace(/\b(2160p|1080p|720p|4k|uhd|hdr|dv|bluray|remux|web[- ]?dl)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleScore(filename, query) {
  const a = normalize(filename);
  const b = normalize(query);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b)) return 95;
  const bt = b.split(' ').filter(x => x.length > 2 && !['live','concert','tour','show'].includes(x));
  const at = new Set(a.split(' '));
  if (!bt.length) return 0;
  const matched = bt.filter(x => at.has(x)).length;
  const ratio = matched / bt.length;
  let score = Math.round(ratio * 80);
  if (/\b(concert|live|tour|unplugged|festival)\b/.test(a)) score += 15;
  const year = b.match(/\b(19\d{2}|20\d{2})\b/)?.[0];
  if (year && a.includes(year)) score += 10;
  return score;
}

function qualityScore(name) {
  const s = String(name || '');
  if (/\b(2160p|4k|uhd)\b/i.test(s)) return 40;
  if (/\b1080p\b/i.test(s)) return 30;
  if (/\b720p\b/i.test(s)) return 20;
  return 0;
}

async function buildConcertStreams(runtime, req) {
  const title = decodeConcertId(req?.params?.id);
  if (!title) return { streams: [] };
  const cfg = runtime.unifiedConfig(req);
  const [fa, wa] = await Promise.all([
    fastshareLogin(cfg.fastshare || {}),
    webshareLogin(cfg.webshare || {})
  ]);
  const base = cleanQuery(title);
  const noYear = base.replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
  const terms = [...new Set([base, noYear].filter(x => x.length >= 3))];
  const [fr, wr] = await Promise.all([
    fa.ok ? mapWithConcurrency(terms, 2, t => searchFastshare(t, fa.hash)) : [],
    wa.ok ? mapWithConcurrency(terms, 2, t => searchWebshare(t, wa.token)) : []
  ]);
  const files = [
    ...(fr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'FastShare' }))),
    ...(wr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'Webshare' })))
  ];
  const ranked = files
    .map(file => ({ file, score: titleScore(file.name || '', base) + qualityScore(file.name) }))
    .filter(x => x.score >= 55)
    .sort((a, b) => b.score - a.score || Number(b.file.size || 0) - Number(a.file.size || 0))
    .slice(0, 30);

  const resolved = await mapWithConcurrency(ranked, 4, async ({ file }) => {
    const url = file.provider === 'FastShare'
      ? fastshareStreamUrl(file, fa.hash)
      : await webshareStreamUrl(file, wa.token);
    if (!url) return null;
    return {
      name: 'FastShare + Webshare',
      title: `${file.provider}\n${file.name}`,
      url,
      behaviorHints: {
        bingeGroup: 'fastshare-webshare-unified-concert',
        filename: file.name,
        videoSize: Number(file.size || 0) || undefined
      }
    };
  });
  return { streams: resolved.filter(Boolean) };
}

module.exports = { buildConcertStreams, decodeConcertId };
