'use strict';

const { tmdbLocalCandidates, hasCzSkAudio } = require('./catalogs');
const { getMeta } = require('./metadata');
const { mapWithConcurrency, normalize } = require('./utils');
const { login: fastshareLogin, searchFastshare } = require('./fastshare');
const { login: webshareLogin, searchWebshare } = require('./webshare');

const DUB_IDS = new Set(['unified-czsk-movies', 'unified-czsk-series']);
const LATEST_IDS = new Set(['unified-latest-movies', 'unified-latest-series']);
const RELEASE_SORT_IDS = new Set([...DUB_IDS, 'unified-4k-czsk']);
const TARGET_IDS = new Set([...RELEASE_SORT_IDS, ...LATEST_IDS]);
const CONCERT_IDS = new Set(['unified-concerts', 'unified-concerts-new']);
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

const CONCERT_TERMS = [
  'concert', 'koncert', 'live concert', 'live performance', 'world tour', 'tour live',
  'unplugged', 'festival', 'live at', 'live in', 'music live', 'blu-ray concert',
  'Rock in Rio', 'Wembley live', 'Glastonbury live', 'MTV Unplugged',
  'arena live', 'stadium live', 'live tour', 'music festival', 'full concert'
];
const CONCERT_RX = /\b(concert|koncert|live\s+(at|in|from)|live\s+performance|world\s+tour|tour\s+live|live\s+tour|unplugged|festival|rock\s+in\s+rio|wembley|glastonbury|arena\s+live|stadium\s+live|full\s+concert)\b/i;
const BAD_CONCERT_RX = /\b(documentary|document|interview|behind\s+the\s+scenes|music\s+video|videoclip|sample|trailer|teaser|karaoke)\b/i;

function skipOf(extra) {
  if (!extra) return 0;
  try { return Math.max(0, Number(new URLSearchParams(decodeURIComponent(extra)).get('skip') || 0)); }
  catch { return 0; }
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function yearOf(meta) {
  const values = [meta?._releaseDate, meta?.released, meta?.releaseInfo, meta?.year, meta?.raw?.released, meta?.raw?.releaseInfo];
  for (const value of values) {
    const match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return 0;
}

function releaseKey(meta) {
  const values = [meta?._releaseDate, meta?.released, meta?.raw?.released];
  for (const value of values) {
    const s = String(value || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  }
  const y = yearOf(meta);
  return y ? `${y}-00-00` : '0000-00-00';
}

function releaseSortKey(meta) {
  const key = releaseKey(meta);
  const today = todayKey();
  return key > today ? today : key;
}

function dateKey(value) {
  const s = String(value || '').trim();
  const iso = s.match(/^(19\d{2}|20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return '';
}

function seriesActivityKey(meta) {
  const candidates = [
    meta?._seriesActivityDate,
    meta?.last_air_date,
    meta?.lastAired,
    meta?.lastAiredAt,
    meta?.raw?.last_air_date,
    meta?.raw?.lastAired,
    meta?.raw?.lastAiredAt
  ];
  const videos = Array.isArray(meta?.videos) ? meta.videos : Array.isArray(meta?.raw?.videos) ? meta.raw.videos : [];
  for (const video of videos) candidates.push(video?.released, video?.airDate, video?.aired, video?.firstAired, video?.releaseDate);
  const today = todayKey();
  let best = '';
  for (const value of candidates) {
    const key = dateKey(value);
    if (key && key <= today && key > best) best = key;
  }
  if (best) return best;
  return releaseSortKey(meta);
}

function uploadRank(meta) {
  const ts = Number(meta?._uploadedAt || 0);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

function isWebshareRecent(meta) {
  return String(meta?._providerSource || '').toLowerCase() === 'webshare';
}

function sortNewest(metas) {
  return metas.slice().sort((a, b) => {
    const dateCmp = releaseSortKey(b).localeCompare(releaseSortKey(a));
    if (dateCmp) return dateCmp;
    const uploadedCmp = uploadRank(b) - uploadRank(a);
    if (uploadedCmp) return uploadedCmp;
    const recentCmp = Number(a?._providerRecentRank ?? 999999) - Number(b?._providerRecentRank ?? 999999);
    if (recentCmp) return recentCmp;
    return normalize(a?.name || '').localeCompare(normalize(b?.name || ''));
  });
}

function sortRecentAdded(metas) {
  return metas.slice().sort((a, b) => {
    const au = uploadRank(a), bu = uploadRank(b);
    if (au || bu) {
      if (au !== bu) return bu - au;
    }

    const aWebRecent = isWebshareRecent(a);
    const bWebRecent = isWebshareRecent(b);
    const ar = Number(a?._providerRecentRank ?? 999999);
    const br = Number(b?._providerRecentRank ?? 999999);
    if (aWebRecent && bWebRecent && ar !== br) return ar - br;

    const aDate = String(a?.type || '').toLowerCase() === 'series' ? seriesActivityKey(a) : releaseSortKey(a);
    const bDate = String(b?.type || '').toLowerCase() === 'series' ? seriesActivityKey(b) : releaseSortKey(b);
    const dateCmp = bDate.localeCompare(aDate);
    if (dateCmp) return dateCmp;

    if (ar !== br) return ar - br;
    return normalize(a?.name || '').localeCompare(normalize(b?.name || ''));
  });
}

function strongDubMeta(meta) {
  const locale = String(meta?._nativeLocale || '').toLowerCase();
  if (locale === 'cz' || locale === 'sk') return true;
  const filename = String(meta?.behaviorHints?.filename || '');
  if (!filename) return false;
  return hasCzSkAudio({ name: filename, audio: undefined });
}

function dedupe(metas, limit = 120) {
  const out = [];
  const seen = new Set();
  for (const item of metas || []) {
    const id = String(item?.id || '');
    const key = id || `${normalize(item?.name || '')}|${yearOf(item)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function orderSummary(id, metas) {
  return (metas || []).slice(0, 12).map((m, index) => ({
    p: index + 1,
    name: String(m?.name || '').slice(0, 60),
    release: releaseKey(m),
    effectiveRelease: releaseSortKey(m),
    ...(String(m?.type || '') === 'series' || id.includes('series') ? { activity: seriesActivityKey(m) } : {}),
    uploadedAt: uploadRank(m) ? new Date(uploadRank(m)).toISOString().slice(0, 10) : '',
    recent: Number.isFinite(Number(m?._providerRecentRank)) ? Number(m._providerRecentRank) : null,
    source: m?._providerSource || '',
    native: m?._nativeLocale || ''
  }));
}

async function capturePreviousCatalog(runtime, req) {
  if (typeof runtime.sendCatalog !== 'function') return { metas: [] };
  return await new Promise(async resolve => {
    let settled = false;
    const finish = payload => {
      if (settled) return;
      settled = true;
      if (payload && Array.isArray(payload.metas)) return resolve(payload);
      return resolve({ metas: [] });
    };
    const res = {
      set() { return this; },
      setHeader() { return this; },
      status() { return this; },
      json(payload) { finish(payload); return this; },
      send(payload) {
        if (typeof payload === 'string') {
          try { return finish(JSON.parse(payload)); } catch { return finish({ metas: [] }); }
        }
        finish(payload);
        return this;
      },
      end() { finish({ metas: [] }); return this; }
    };
    try {
      const maybe = await runtime.sendCatalog(req, res);
      if (!settled && maybe && Array.isArray(maybe.metas)) finish(maybe);
      if (!settled) setTimeout(() => finish({ metas: [] }), 100);
    } catch {
      finish({ metas: [] });
    }
  });
}

async function nativeOriginals(runtime, req) {
  const type = req.params.type;
  const key = `native-v6:${type}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  let bases = [];
  try { bases = await tmdbLocalCandidates(type, 0); } catch { bases = []; }
  const recent = bases.filter(base => yearOf(base) >= new Date().getFullYear() - 4).slice(0, 90);

  const rows = await mapWithConcurrency(recent, 5, async base => {
    try {
      const meta = await getMeta(type, base.id);
      const fakeReq = { ...req, params: { ...(req.params || {}), type, id: base.id } };
      const response = typeof runtime.buildQualityResponse === 'function'
        ? await runtime.buildQualityResponse(fakeReq)
        : { streams: [] };
      if (!Array.isArray(response?.streams) || response.streams.length === 0) return null;
      const raw = meta?.raw || {};
      return {
        ...raw,
        id: raw.id || meta.imdbId || base.id,
        type,
        name: raw.name || raw.title || meta.title || base.name,
        poster: raw.poster || base.poster,
        background: raw.background || base.background,
        description: raw.description || base.description,
        releaseInfo: raw.releaseInfo || base.releaseInfo,
        year: raw.year || base.year,
        _releaseDate: base._releaseDate,
        _nativeLocale: base._nativeLocale,
        behaviorHints: {
          ...(raw.behaviorHints || {}),
          ...(type === 'movie' ? { defaultVideoId: raw.id || meta.imdbId || base.id } : {})
        }
      };
    } catch { return null; }
  });

  const value = rows.filter(Boolean);
  cache.set(key, { at: Date.now(), value });
  return value;
}

function cleanConcertTitle(filename) {
  return String(filename || '')
    .replace(/\.[a-z0-9]{2,5}$/i, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|dolby|web[- ]?dl|webrip|bluray|brrip|hdrip|dvdrip|remux|x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|ddp|dd|dts|truehd|atmos|flac|mp3)\b/ig, ' ')
    .replace(/\b(cz|cze|cs|sk|svk|eng|en)\s*(dab|dub|dabing|audio|subs?|tit|titulky)?\b/ig, ' ')
    .replace(/\b(proper|repack|internal|limited|complete|extended)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 170);
}

function encodeConcertId(title) {
  return `concert:${Buffer.from(String(title || '').slice(0, 180), 'utf8').toString('base64url')}`;
}

async function supplementalConcerts(runtime, req) {
  const cfg = runtime.unifiedConfig ? runtime.unifiedConfig(req) : {};
  const key = `concert-extra-v6:${cfg?.fastshare?.username || ''}|${cfg?.webshare?.username || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const [fa, wa] = await Promise.all([
    cfg?.fastshare?.username && cfg?.fastshare?.password ? fastshareLogin(cfg.fastshare) : Promise.resolve({ ok: false }),
    cfg?.webshare?.username && cfg?.webshare?.password ? webshareLogin(cfg.webshare) : Promise.resolve({ ok: false })
  ]);

  const [fr, wr] = await Promise.all([
    fa.ok ? mapWithConcurrency(CONCERT_TERMS, 5, term => searchFastshare(term, fa.hash)) : [],
    wa.ok ? mapWithConcurrency(CONCERT_TERMS, 5, term => searchWebshare(term, wa.token)) : []
  ]);

  const files = [
    ...(fr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'FastShare' }))),
    ...(wr || []).flatMap(r => (r.files || []).map(f => ({ ...f, provider: 'Webshare' })))
  ].filter(file => {
    const name = String(file?.name || '');
    return CONCERT_RX.test(name) && !BAD_CONCERT_RX.test(name) && (Number(file?.size || 0) > 120 * 1024 * 1024 || /\.(mkv|mp4|avi|mov|m4v)(?:$|[?\s])/i.test(name));
  });

  const byKey = new Map();
  for (const file of files) {
    const title = cleanConcertTitle(file.name);
    const k = normalize(title).replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length < 5) continue;
    const prev = byKey.get(k);
    if (!prev || Number(file.size || 0) > Number(prev.size || 0)) {
      byKey.set(k, { title, filename: file.name, provider: file.provider, size: Number(file.size || 0) });
    }
  }

  const rawRows = [...byKey.values()].slice(0, 240);
  const enriched = await mapWithConcurrency(rawRows, 6, async row => {
    try {
      let meta = null;
      if (typeof runtime.enrichConcertWithWikipedia === 'function') meta = await runtime.enrichConcertWithWikipedia(row);
      if (!meta && typeof runtime.enrichConcert === 'function') meta = await runtime.enrichConcert(row);
      meta = meta || row;
      const id = encodeConcertId(row.title);
      return {
        ...meta,
        id,
        type: 'movie',
        name: meta.name || row.title,
        releaseInfo: meta.releaseInfo || String(row.title).match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '',
        year: meta.year,
        genres: meta.genres?.length ? meta.genres : ['Music'],
        description: meta.description || `Živý koncert ${row.title}.`,
        behaviorHints: { ...(meta.behaviorHints || {}), defaultVideoId: id, filename: row.filename }
      };
    } catch { return null; }
  });

  const value = enriched.filter(Boolean);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function buildFinal(runtime, req) {
  const id = req.params.id;

  if (TARGET_IDS.has(id)) {
    const base = await capturePreviousCatalog(runtime, req);
    const baseMetas = Array.isArray(base?.metas) ? base.metas : [];

    if (DUB_IDS.has(id)) {
      const natives = await nativeOriginals(runtime, req);
      const foreign = baseMetas.filter(strongDubMeta);
      const merged = dedupe([...foreign, ...natives], 120);
      const sorted = sortNewest(merged);
      return { metas: sorted.slice(0, 40), _debug: { base: baseMetas.length, strongDub: foreign.length, natives: natives.length } };
    }

    if (LATEST_IDS.has(id)) {
      return { metas: sortRecentAdded(dedupe(baseMetas, 120)).slice(0, 40), _debug: { base: baseMetas.length } };
    }

    if (id === 'unified-4k-czsk') {
      const strong = baseMetas.filter(strongDubMeta);
      return { metas: sortNewest(dedupe(strong, 120)).slice(0, 40), _debug: { base: baseMetas.length, strongDub: strong.length } };
    }
  }

  if (CONCERT_IDS.has(id)) {
    const [pool, extra] = await Promise.all([
      typeof runtime.buildConcertPool === 'function' ? runtime.buildConcertPool(req).catch(() => []) : Promise.resolve([]),
      supplementalConcerts(runtime, req)
    ]);
    const poolMetas = await mapWithConcurrency((pool || []).slice(0, 220), 6, async row => {
      try {
        let meta = null;
        if (typeof runtime.enrichConcertWithWikipedia === 'function') meta = await runtime.enrichConcertWithWikipedia(row);
        if (!meta && typeof runtime.enrichConcert === 'function') meta = await runtime.enrichConcert(row);
        meta = meta || row;
        const title = row.title || row.name || meta.name;
        const cid = encodeConcertId(title);
        return {
          ...meta,
          id: cid,
          type: 'movie',
          name: meta.name || title,
          releaseInfo: meta.releaseInfo || row._year || yearOf(row) || '',
          behaviorHints: { ...(meta.behaviorHints || {}), defaultVideoId: cid, ...(row.filename ? { filename: row.filename } : {}) }
        };
      } catch { return null; }
    });
    let metas = dedupe([...(poolMetas.filter(Boolean)), ...extra], 160);
    if (id === 'unified-concerts-new') metas = sortNewest(metas);
    else metas = metas.sort((a, b) => normalize(a?.name || '').localeCompare(normalize(b?.name || '')) || yearOf(b) - yearOf(a));
    const skip = skipOf(req.params.extra);
    return { metas: metas.slice(skip, skip + 40), _debug: { pool: pool.length, extra: extra.length } };
  }

  return null;
}

function install(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;
  const paths = new Set([
    '/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json',
    '/:config/catalog/:type/:id.json', '/:config/catalog/:type/:id/:extra.json'
  ]);
  app._router.stack = app._router.stack.filter(layer => !layer.route || !paths.has(layer.route.path));

  async function sendCatalog(req, res) {
    const id = req.params.id;
    if (!TARGET_IDS.has(id) && !CONCERT_IDS.has(id)) return runtime.sendCatalog(req, res);
    try {
      const result = await buildFinal(runtime, req);
      res.set('Cache-Control', 'no-store, max-age=0');
      console.log('[catalog-finalizer-v6]', JSON.stringify({ id, type: req.params.type, count: result?.metas?.length || 0, ...(result?._debug || {}) }));
      if (TARGET_IDS.has(id)) console.log('[catalog-order-v6]', JSON.stringify({ id, top: orderSummary(id, result?.metas || []) }));
      return res.json({ metas: result?.metas || [] });
    } catch (error) {
      console.error('[catalog-finalizer-error]', String(error?.message || error));
      return runtime.sendCatalog(req, res);
    }
  }

  app.get('/catalog/:type/:id.json', sendCatalog);
  app.get('/catalog/:type/:id/:extra.json', sendCatalog);
  app.get('/:config/catalog/:type/:id.json', sendCatalog);
  app.get('/:config/catalog/:type/:id/:extra.json', sendCatalog);

  return { ...runtime, buildFinalCatalog: req => buildFinal(runtime, req) };
}

module.exports = install;
