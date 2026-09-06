'use strict';

const {
  MAX_SEARCH_TERMS,
  PRIMARY_SEARCH_TERMS,
  MAX_TITLE_ALIASES
} = require('./config');
const {
  normalize,
  uniqueStrings,
  uniqueSearchTerms,
  levenshtein,
  similarity
} = require('./utils');

const GENERIC_MEDIA_TITLE_TOKENS = new Set([
  'live', 'concert', 'tour', 'show', 'performance', 'special', 'edition',
  'version', 'complete', 'full', 'movie', 'film', 'video', 'collection', 'pack'
]);

const BUILTIN_TITLE_ALIASES = Object.freeze({
  tt33612209: [
    'The Devil Wears Prada 2',
    'Dabel nosi Pradu 2',
    'Diabol nosi Pradu 2'
  ]
});

function loadEnvTitleAliases() {
  try {
    const parsed = JSON.parse(process.env.TITLE_ALIASES_JSON || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [id, aliases] of Object.entries(parsed)) {
      if (!/^tt\d+$/.test(id) || !Array.isArray(aliases)) continue;
      out[id] = aliases.filter(x => typeof x === 'string' && x.trim()).slice(0, 20);
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_TITLE_ALIASES = loadEnvTitleAliases();

function fuzzyTokenMatch(expected, actual) {
  const left = String(expected || '');
  const right = String(actual || '');
  if (!left || !right) return false;
  if (left === right) return true;

  const maxLen = Math.max(left.length, right.length);
  const minLen = Math.min(left.length, right.length);
  if (minLen < 5 || Math.abs(left.length - right.length) > 2) return false;

  const distance = levenshtein(left, right);
  const allowedDistance = maxLen >= 9 ? 2 : 1;
  if (distance > allowedDistance) return false;

  // v6.4: no more "same first four letters = match" shortcut. Shorter words
  // need 80% similarity, longer words need at least 82% similarity.
  const threshold = maxLen <= 6 ? 0.80 : 0.82;
  return similarity(left, right) >= threshold;
}

function extractAliasValues(raw) {
  const values = [];
  const keys = ['name', 'title', 'originalName', 'originalTitle', 'localizedTitle', 'localTitle'];
  for (const key of keys) if (raw && typeof raw[key] === 'string') values.push(raw[key]);
  const listKeys = ['aliases', 'alternativeTitles', 'alternateTitles', 'aka', 'akas'];
  for (const key of listKeys) {
    const list = raw && raw[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') values.push(item);
      else if (item && typeof item === 'object') values.push(item.title, item.name);
    }
  }
  return values.filter(Boolean);
}

function orderedLocalizedAliases(meta) {
  const details = Array.isArray(meta?.localizedTitleData?.aliasDetails)
    ? meta.localizedTitleData.aliasDetails
    : [];
  const cs = [];
  const sk = [];
  const original = [];
  const other = [];

  for (const item of details) {
    const title = String(item?.title || '').trim();
    if (!title) continue;
    const language = String(item?.language || '').toLowerCase();
    if (['cs', 'cz', 'cze'].includes(language)) cs.push(title);
    else if (['sk', 'svk'].includes(language)) sk.push(title);
    else if (['original', 'en', 'eng'].includes(language)) original.push(title);
    else other.push(title);
  }

  // Some providers return only a flattened list. Keep it after language-tagged
  // aliases so Czech and Slovak titles keep priority when the limit is reached.
  other.push(...(meta?.localizedAliases || []));
  return { cs, sk, original, other };
}

function getTitleAliases(meta) {
  const imdbId = String(meta?.imdbId || '').split(':')[0];
  const localized = orderedLocalizedAliases(meta);
  return uniqueStrings([
    // Main metadata title is pinned first and can never be pushed out by aliases.
    meta?.title,
    ...localized.cs,
    ...localized.sk,
    ...localized.original,
    ...localized.other,
    ...extractAliasValues(meta?.raw || {}),
    ...(ENV_TITLE_ALIASES[imdbId] || []),
    ...(BUILTIN_TITLE_ALIASES[imdbId] || [])
  ]).slice(0, MAX_TITLE_ALIASES);
}

function extractSequelNumber(value) {
  const raw = String(value || '')
    .replace(/\b(?:ddp?|aac|ac3|dts)[ ._-]?(?:2|5|7)[ ._-]?1\b/gi, ' ')
    .replace(/\b(?:x|h)[ ._-]?26[45]\b/gi, ' ');
  const n = normalize(raw)
    .replace(/\b(19\d{2}|20\d{2}|2160p|1080p|720p|480p)\b/g, ' ')
    .replace(/\b(cz|cze|sk|svk|en|eng|dabing|dubbing|dub|web|webrip|webdl|bluray|brrip|hdr|mkv|mp4|avi)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const patterns = [
    /\b(?:part|chapter|cast|dil|film)\s*(\d{1,2})\b/,
    /\b(?:part|chapter)\s*(ii|iii|iv|v)\b/,
    /\b(\d{1,2})\s*$/,
    /\b(ii|iii|iv|v)\s*$/
  ];
  for (const rx of patterns) {
    const match = n.match(rx);
    if (!match) continue;
    const token = match[1];
    if (/^\d+$/.test(token)) return Number(token);
    return ({ ii: 2, iii: 3, iv: 4, v: 5 })[token] || 0;
  }
  const standalone = [...n.matchAll(/\b([2-5])\b/g)];
  return standalone.length ? Number(standalone[standalone.length - 1][1]) : 0;
}

function getYears(name) {
  return [...String(name || '').matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(match => match[1]);
}

function sequelMismatch(name, meta, aliases = getTitleAliases(meta)) {
  const expected = aliases.map(extractSequelNumber).find(n => n >= 2 && n <= 5) || 0;
  if (!expected) return false;
  const candidate = extractSequelNumber(name);
  if (candidate && candidate !== expected) return true;
  if (!candidate) {
    const metaYear = String(meta.year || meta.releaseInfo || '').match(/\d{4}/)?.[0] || '';
    const years = getYears(name);
    if (metaYear && years.length && !years.includes(metaYear)) return true;
  }
  return false;
}

function parseSeriesRelease(name) {
  const raw = String(name || '');
  const normalized = normalize(raw);
  const episodes = [];

  for (const match of raw.matchAll(/\bS(\d{1,2})((?:E\d{1,3})+)\b/ig)) {
    const season = Number(match[1]);
    const values = [...match[2].matchAll(/E(\d{1,3})/ig)].map(x => Number(x[1]));
    episodes.push({ season, episodes: values });
  }
  for (const match of raw.matchAll(/\b(\d{1,2})x(\d{1,3})\b/ig)) {
    episodes.push({ season: Number(match[1]), episodes: [Number(match[2])] });
  }
  for (const match of normalized.matchAll(/\b(?:season|series|seria)\s*(\d{1,2})\s*(?:episode|ep|epizoda|dil|cast)\s*(\d{1,3})\b/g)) {
    episodes.push({ season: Number(match[1]), episodes: [Number(match[2])] });
  }

  const seasonPacks = [];
  for (const match of normalized.matchAll(/\bs0?(\d{1,2})\b[^\n]{0,40}\b(?:complete|komplet|pack|cela|cel[aá])\b/g)) {
    seasonPacks.push(Number(match[1]));
  }
  for (const match of normalized.matchAll(/\b(?:season|series|seria)\s*(\d{1,2})\b[^\n]{0,40}\b(?:complete|komplet|pack|cela|cel[aá])\b/g)) {
    seasonPacks.push(Number(match[1]));
  }

  return { episodes, seasonPacks: [...new Set(seasonPacks)] };
}

function seriesCandidateKind(name, meta) {
  if (meta?.type !== 'series' || !meta?.season || !meta?.episode) return 'not-series-request';
  const targetSeason = Number(meta.season);
  const targetEpisode = Number(meta.episode);
  const parsed = parseSeriesRelease(name);

  if (parsed.episodes.length) {
    for (const entry of parsed.episodes) {
      if (entry.season !== targetSeason) continue;
      if (entry.episodes.includes(targetEpisode)) {
        return entry.episodes.length > 1 ? 'multi-episode' : 'exact-episode';
      }
    }
    return 'episode-mismatch';
  }

  if (parsed.seasonPacks.includes(targetSeason)) return 'season-pack';
  if (parsed.seasonPacks.length) return 'season-mismatch';
  return 'loose-series';
}

function episodePatternScore(name, meta) {
  const kind = seriesCandidateKind(name, meta);
  if (kind === 'exact-episode') return { score: 180, reason: 'exact-episode +180', kind };
  if (kind === 'multi-episode') return { score: 150, reason: 'multi-episode +150', kind };
  if (kind === 'season-pack') return { score: 15, reason: 'season-pack fallback +15', kind };
  return { score: 0, reason: null, kind };
}

function hasEpisodePattern(name) {
  return /\bS\d{1,2}E\d{1,3}\b/i.test(String(name || '')) || /\b\d{1,2}x\d{1,3}\b/i.test(String(name || ''));
}

function aliasMatchScore(fileName, alias) {
  const file = normalize(fileName);
  const title = normalize(alias);
  if (!title) return { score: -80, strong: false, ratio: 0, matched: 0, total: 0, strictShortTitle: false, distinctiveMatched: 0, distinctiveTotal: 0 };

  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'with', 'for', 'from']);
  const titleTokens = title.split(' ').filter(x => (x.length > 1 || /^\d+$/.test(x)) && !stop.has(x));
  const lexicalTokens = titleTokens.filter(x => !/^\d+$/.test(x));
  const distinctiveTokens = lexicalTokens.filter(x => !GENERIC_MEDIA_TITLE_TOKENS.has(x));
  const strictShortTitle = lexicalTokens.length === 1;
  const fileTokens = file.split(' ').filter(Boolean);
  const used = new Set();
  let matched = 0;
  let distinctiveMatched = 0;

  for (const expected of titleTokens) {
    const isNumber = /^\d+$/.test(expected);
    const index = fileTokens.findIndex((actual, i) => {
      if (used.has(i)) return false;
      if (strictShortTitle || isNumber) return expected === actual;
      return fuzzyTokenMatch(expected, actual);
    });
    if (index >= 0) {
      used.add(index);
      matched++;
      if (!isNumber && !GENERIC_MEDIA_TITLE_TOKENS.has(expected)) distinctiveMatched++;
    }
  }

  const total = titleTokens.length;
  const distinctiveTotal = distinctiveTokens.length;
  const ratio = total ? matched / total : 0;
  const exactPhrase = strictShortTitle ? total > 0 && matched === total : title.length >= 4 && file.includes(title);
  const enoughDistinctive = distinctiveTotal === 0 || distinctiveMatched >= Math.min(2, distinctiveTotal);
  const strong = exactPhrase || matched === total || (ratio >= 0.67 && enoughDistinctive) || (matched >= 2 && ratio >= 0.5 && enoughDistinctive);

  let score = -80;
  if (exactPhrase) score = 130;
  else if (total && matched === total) score = 110;
  else if (ratio >= 0.67 && enoughDistinctive) score = 75;
  else if (matched >= 2 && enoughDistinctive) score = 45;
  else if (matched === 1) score = 15;

  return { score, strong, ratio, matched, total, strictShortTitle, distinctiveMatched, distinctiveTotal };
}

function titleMatchScore(fileName, meta, type) {
  const aliases = getTitleAliases(meta);
  const year = String(meta.year || meta.releaseInfo || '').match(/\d{4}/)?.[0] || '';
  const acceptedYears = uniqueStrings([year, ...aliases.flatMap(getYears)]).filter(x => /^(19|20)\d{2}$/.test(x));
  let score = 0;
  const reasons = [];

  if (type === 'movie' && hasEpisodePattern(fileName)) {
    return { reject: true, score: -999, reasons: ['movie-episode-pattern reject'] };
  }
  if (sequelMismatch(fileName, meta, aliases)) {
    return { reject: true, score: -999, reasons: ['sequel-mismatch reject'] };
  }

  const seriesKind = type === 'series' ? seriesCandidateKind(fileName, meta) : null;
  if (['episode-mismatch', 'season-mismatch'].includes(seriesKind)) {
    return { reject: true, score: -999, reasons: [`${seriesKind} reject`], seriesKind };
  }

  const candidates = aliases.map(alias => ({ alias, ...aliasMatchScore(fileName, alias) }));
  const best = candidates.sort((a, b) => b.score - a.score || b.ratio - a.ratio)[0] || {
    alias: meta.title || '', score: -80, strong: false, matched: 0, total: 0
  };

  if (type === 'movie' && !best.strong) {
    return { reject: true, score: -999, reasons: ['weak-title-match reject'] };
  }
  if (type === 'series' && !best.strong) {
    const exactEpisode = ['exact-episode', 'multi-episode'].includes(seriesKind);
    const hasTitleEvidence = best.matched > 0 && best.score > 0;
    // An exact SxxExx pattern may relax how much of a multi-word title must match,
    // but it must never replace title validation completely. This prevents false
    // positives such as Reacher S04E07 resolving to Preacher S04E07.
    if (!exactEpisode || !hasTitleEvidence) {
      return { reject: true, score: -999, reasons: ['weak-series-title reject'], seriesKind };
    }
  }

  const strongTitle = best.strong;
  score += best.score;
  if (best.score >= 110) reasons.push(`title-alias-exact +${best.score} (${best.alias})`);
  else if (best.score > 0) reasons.push(`title-alias-partial +${best.score} (${best.matched}/${best.total})`);
  else reasons.push('title-miss -80');

  const years = getYears(fileName);
  if (acceptedYears.length) {
    if (years.some(y => acceptedYears.includes(y))) {
      score += 50;
      reasons.push('year/title-year +50');
    } else if (years.length) {
      const fileYear = Number(years[0]);
      const diff = Math.min(...acceptedYears.map(y => Math.abs(fileYear - Number(y))));
      if (strongTitle && diff === 1) {
        score -= 20;
        reasons.push('year off by 1 strong-title -20');
      } else if (strongTitle && diff <= 2) {
        score -= 45;
        reasons.push('year off by 2 strong-title -45');
      } else if (strongTitle) {
        score -= 90;
        reasons.push('different-year strong-title -90');
      } else {
        return { reject: true, score: -999, reasons: ['different-year weak-title reject'], seriesKind };
      }
    }
  }

  if (type === 'series') {
    const episode = episodePatternScore(fileName, meta);
    if (episode.score) {
      score += episode.score;
      reasons.push(episode.reason);
    }
    if (['exact-episode', 'multi-episode'].includes(seriesKind) && !strongTitle) {
      score += 60;
      reasons.push('series-title-relaxed +60');
    }
  }

  return { reject: false, score, reasons, seriesKind };
}

function parseRuntimeSeconds(meta) {
  const runtime = meta && (meta.runtime || meta.raw?.runtime);
  const match = String(runtime || '').match(/(\d+)\s*min/i);
  return match ? Number(match[1]) * 60 : 0;
}

function runtimeScore(file, meta) {
  const expected = parseRuntimeSeconds(meta);
  const duration = Number(file.duration || file.raw?.duration?.value || 0);
  if (!expected || !duration) return { score: 0, reason: null };
  const diff = Math.abs(duration - expected);
  if (diff <= 180) return { score: 25, reason: 'runtime exact +25' };
  if (diff <= 1500) return { score: 15, reason: 'runtime close +15' };
  if (diff >= 3000) return { score: -50, reason: 'runtime far -50' };
  return { score: 0, reason: null };
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
  const czSubs = /\b(cz|cze|cs|ceske|cesky|czech)\s*(tit|titulky|sub|subs|subtitle|forced|title)\b|cztit|czforced/.test(n);
  const skSubs = /\b(sk|svk|slovak|slovensky)\s*(tit|titulky|sub|subs|subtitle|forced|title)\b|sktit|skforced/.test(n);
  const czDubStrong = /czdab|\b(cz|cze|cs|ceske|cesky)\s*(dab|dub|dabing|dubbing|audio)\b|\b(czech)\s*(audio|dub|dubbing)\b/.test(n);
  const skDubStrong = /skdab|\b(sk|svk|slovak|slovensky)\s*(dab|dub|dabing|dubbing|audio)\b|\b(slovak)\s*(audio|dub|dubbing)\b/.test(n);
  const enStrong = /\b(en|eng|english)\s*(audio|dab|dub|dabing|dubbing)\b|\b(en|eng)\s*dabing\b/.test(n);
  const hasCZ = /(^|[^a-z])(cz|cze|cs|cesky|czech)([^a-z]|$)/.test(n);
  const hasSK = /(^|[^a-z])(sk|svk|slovak|slovensky)([^a-z]|$)/.test(n);
  const hasEN = /(^|[^a-z])(en|eng|english)([^a-z]|$)/.test(n);
  const audioEvidence = '(?:aac|ac3|eac3|ddp|dd|dts|truehd|atmos|mp3|flac|opus|vorbis|pcm|2\\s*0|5\\s*1|7\\s*1)';
  function languageNearAudio(languagePattern) {
    const forward = new RegExp('\\b(?:' + languagePattern + ')\\b(?:\\s+[a-z0-9]+){0,3}\\s+\\b' + audioEvidence + '\\b');
    const reverse = new RegExp('\\b' + audioEvidence + '\\b(?:\\s+[a-z0-9]+){0,3}\\s+\\b(?:' + languagePattern + ')\\b');
    return forward.test(n) || reverse.test(n);
  }
  const czAudioContext = !czSubs && languageNearAudio('cz|cze|cs|cesky|czech');
  const skAudioContext = !skSubs && languageNearAudio('sk|svk|slovak|slovensky');
  const enAudioContext = languageNearAudio('en|eng|english');
  const explicitMulti = /multi\s*audio|dual\s*audio/.test(n);
  const genericDub = /\b(dab|dub|dabing|dubbing|dubbed)\b/.test(n);

  let label = 'Audio neznáme';
  let key = 'any';
  let score = 0;
  let verifiedAudio = false;
  let evidence = 'none';
  if ((czDubStrong || czAudioContext) && (skDubStrong || skAudioContext)) {
    label = 'CZ/SK Dabing'; key = 'CZ-SK'; score = 105; verifiedAudio = true; evidence = 'explicit-or-codec';
  } else if (czDubStrong) {
    label = 'CZ Dabing'; key = 'CZ'; score = 100; verifiedAudio = true; evidence = 'explicit-dub';
  } else if (skDubStrong) {
    label = 'SK Dabing'; key = 'SK'; score = 80; verifiedAudio = true; evidence = 'explicit-dub';
  } else if (czAudioContext && enAudioContext) {
    label = 'CZ/EN Audio'; key = 'CZ-EN'; score = 85; verifiedAudio = true; evidence = 'audio-codec';
  } else if (skAudioContext && enAudioContext) {
    label = 'SK/EN Audio'; key = 'SK-EN'; score = 55; verifiedAudio = true; evidence = 'audio-codec';
  } else if (czAudioContext) {
    label = 'CZ Audio'; key = 'CZ'; score = 70; verifiedAudio = true; evidence = 'audio-codec';
  } else if (skAudioContext) {
    label = 'SK Audio'; key = 'SK'; score = 55; verifiedAudio = true; evidence = 'audio-codec';
  } else if (enStrong || enAudioContext) {
    label = 'EN Audio'; key = 'EN'; score = 40; verifiedAudio = true; evidence = enStrong ? 'explicit-audio' : 'audio-codec';
  } else if (explicitMulti) {
    label = 'Multi Audio'; key = 'multi'; score = 30; verifiedAudio = true; evidence = 'explicit-audio';
  } else if (genericDub) {
    label = 'Dabing – jazyk neznámy'; key = 'dub'; score = 55; verifiedAudio = true; evidence = 'generic-dub';
  } else if (czSubs) {
    label = 'CZ titulky'; key = 'sub'; score = 5; evidence = 'subtitle';
  } else if (skSubs) {
    label = 'SK titulky'; key = 'sub'; score = 5; evidence = 'subtitle';
  } else if (hasCZ || hasSK || hasEN) {
    score = 5;
    evidence = 'bare-language-token';
  }

  const subs = [];
  if (czSubs && label !== 'CZ titulky') subs.push('CZ titulky');
  if (skSubs && label !== 'SK titulky') subs.push('SK titulky');
  const subScore = (czSubs && label !== 'CZ titulky' ? 15 : 0) + (skSubs && label !== 'SK titulky' ? 10 : 0);
  return { label, key, score, subs, subScore, verifiedAudio, evidence };
}

function getExt(name) {
  const match = String(name || '').match(/\.([a-z0-9]{2,5})(?:$|[\s\]\)])/i);
  if (!match) return '';
  const ext = match[1].toUpperCase();
  return ['MKV', 'MP4', 'AVI', 'MOV', 'M4V'].includes(ext) ? ext : '';
}

function qualityScore(quality) {
  if (quality === '4K') return [30, '4K +30'];
  if (quality === '1080p') return [20, '1080p +20'];
  if (quality === '720p') return [10, '720p +10'];
  if (quality === '480p') return [-5, '480p -5'];
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
  const match = titleMatchScore(name, meta, type);
  if (match.reject) return null;
  let score = match.score;
  const reasons = [...match.reasons];
  const audio = detectAudio(name);
  score += audio.score + audio.subScore;
  reasons.push(`${audio.label} +${audio.score}`);
  if (audio.subScore) reasons.push(`subtitles +${audio.subScore}`);
  const quality = detectQuality(name);
  const [qualityPoints, qualityReason] = qualityScore(quality);
  score += qualityPoints;
  if (qualityReason) reasons.push(qualityReason);
  const ext = getExt(name);
  const [extPoints, extReason] = extScore(ext);
  score += extPoints;
  if (extReason) reasons.push(extReason);
  const [sizePoints, sizeReason] = sizeScore(file.size || file.raw?.data?.value);
  score += sizePoints;
  if (sizeReason) reasons.push(sizeReason);
  const runtime = runtimeScore(file, meta);
  score += runtime.score;
  if (runtime.reason) reasons.push(runtime.reason);
  const [badPoints, badReason] = badQualityPenalty(name);
  score += badPoints;
  if (badReason) reasons.push(badReason);
  return { ...file, score, scoreReasons: reasons, audio, quality, ext, seriesKind: match.seriesKind || null };
}

function dedupe(files) {
  const map = new Map();
  for (const file of files) {
    const nameKey = normalize(file.name)
      .replace(/\b(2160p|1080p|720p|480p|4k|uhd|fullhd|fhd|mkv|mp4|avi|cz|sk|en|eng|cze|dabing|dab|extended|cut)\b/g, '')
      .replace(/\s+/g, ' ').trim();
    const key = `${nameKey}|${file.quality}|${file.audio.key}`;
    if (!map.has(key) || file.score > map.get(key).score) map.set(key, file);
  }
  return [...map.values()];
}

function rankFiles(files, meta, type) {
  const threshold = type === 'series' ? 20 : 50;
  let scored = (files || []).map(file => scoreFile(file, meta, type)).filter(Boolean).filter(file => file.score > threshold);

  // Exact or multi-episode files always beat season packs/loose series matches.
  // Packs remain available only when no standalone matching episode was found.
  if (type === 'series') {
    const hasStandalone = scored.some(file => ['exact-episode', 'multi-episode'].includes(file.seriesKind));
    if (hasStandalone) scored = scored.filter(file => ['exact-episode', 'multi-episode'].includes(file.seriesKind));
  }

  return dedupe(scored).sort((a, b) => b.score - a.score);
}

function significantTitleTokens(title) {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'with', 'for', 'from']);
  return normalize(title).split(' ').filter(x => (x.length > 2 || /^\d+$/.test(x)) && !stop.has(x));
}

function movieSearchTermPlan(meta) {
  const aliases = getTitleAliases(meta);
  const year = String(meta.year || '').match(/\d{4}/)?.[0] || '';
  const priorityAliases = aliases.slice(0, 3);
  const primary = [];

  // First cover three distinct preferred titles (main/CZ/SK when available),
  // then add their exact no-year forms. This prevents one title from consuming
  // the whole first-stage budget with spelling variants.
  for (const alias of priorityAliases) {
    if (year && getYears(alias).length === 0) primary.push(`${alias} ${year}`);
    else primary.push(alias);
  }
  primary.push(...priorityAliases);

  const fallback = [];
  for (const alias of aliases) {
    const asciiAlias = normalize(alias);
    const tokens = significantTitleTokens(alias);
    const sequel = extractSequelNumber(alias);
    fallback.push(alias);
    if (asciiAlias && asciiAlias.toLocaleLowerCase('en-US') !== String(alias).toLocaleLowerCase('en-US')) fallback.push(asciiAlias);
    if (year && getYears(alias).length === 0) {
      fallback.push(`${alias} ${year}`);
      if (asciiAlias && asciiAlias.toLocaleLowerCase('en-US') !== String(alias).toLocaleLowerCase('en-US')) fallback.push(`${asciiAlias} ${year}`);
    }
    if (tokens.length >= 2) fallback.push(tokens.join(' '));
    const words = tokens.filter(x => !/^\d+$/.test(x) && !GENERIC_MEDIA_TITLE_TOKENS.has(x));
    const last = words[words.length - 1];
    if (last && sequel) {
      fallback.push(`${last} ${sequel}`);
      if (last.length >= 5) fallback.push(`${last.slice(0, 4)} ${sequel}`);
    } else if (last && words.length === 1) {
      fallback.push(last);
    }
  }
  if (meta.imdbId) fallback.push(meta.imdbId);

  const primaryTerms = uniqueSearchTerms(primary).slice(0, PRIMARY_SEARCH_TERMS);
  const primaryKeys = new Set(primaryTerms.map(x => x.toLocaleLowerCase('en-US')));
  const fallbackTerms = uniqueSearchTerms(fallback)
    .filter(x => !primaryKeys.has(x.toLocaleLowerCase('en-US')))
    .slice(0, Math.max(0, MAX_SEARCH_TERMS - primaryTerms.length));
  return { primary: primaryTerms, fallback: fallbackTerms };
}

function seriesSearchTermPlan(meta) {
  const season = Number(meta.season);
  const episode = Number(meta.episode);
  const sp = String(season).padStart(2, '0');
  const ep = String(episode).padStart(2, '0');
  const aliases = getTitleAliases(meta);
  const priorityAliases = aliases.slice(0, 3);
  const primary = [];

  for (const title of priorityAliases) primary.push(`${title} S${sp}E${ep}`);
  for (const title of priorityAliases) {
    const asciiTitle = normalize(title);
    if (asciiTitle && asciiTitle.toLocaleLowerCase('en-US') !== String(title).toLocaleLowerCase('en-US')) {
      primary.push(`${asciiTitle} S${sp}E${ep}`);
    }
  }

  const fallback = [];
  for (const title of aliases) {
    const asciiTitle = normalize(title);
    const variants = uniqueSearchTerms([title, asciiTitle]);
    const tokens = significantTitleTokens(title).filter(x => !/^\d+$/.test(x));
    const shortVariants = uniqueSearchTerms([
      tokens.length >= 2 ? tokens.join(' ') : '',
      tokens.length ? tokens[tokens.length - 1] : ''
    ]);
    for (const variant of variants) {
      fallback.push(`${variant} S${sp}E${ep}`);
      fallback.push(`${variant} ${season}x${ep}`);
      fallback.push(`${variant} season ${season} episode ${episode}`);
      fallback.push(variant);
    }
    for (const variant of shortVariants) {
      fallback.push(`${variant} S${sp}E${ep}`);
      fallback.push(`${variant} ${season}x${ep}`);
    }
  }
  if (meta.imdbId) fallback.push(`${meta.imdbId} S${sp}E${ep}`);

  const primaryTerms = uniqueSearchTerms(primary).slice(0, PRIMARY_SEARCH_TERMS);
  const primaryKeys = new Set(primaryTerms.map(x => x.toLocaleLowerCase('en-US')));
  const fallbackTerms = uniqueSearchTerms(fallback)
    .filter(x => !primaryKeys.has(x.toLocaleLowerCase('en-US')))
    .slice(0, Math.max(0, MAX_SEARCH_TERMS - primaryTerms.length));
  return { primary: primaryTerms, fallback: fallbackTerms };
}

function searchTermPlan(meta) {
  if (meta?.type === 'series' && meta?.season && meta?.episode) return seriesSearchTermPlan(meta);
  return movieSearchTermPlan(meta);
}

function termsFor(meta) {
  const plan = searchTermPlan(meta);
  return [...plan.primary, ...plan.fallback].slice(0, MAX_SEARCH_TERMS);
}

module.exports = {
  GENERIC_MEDIA_TITLE_TOKENS,
  fuzzyTokenMatch,
  getTitleAliases,
  extractSequelNumber,
  parseSeriesRelease,
  seriesCandidateKind,
  aliasMatchScore,
  titleMatchScore,
  detectQuality,
  detectAudio,
  getExt,
  scoreFile,
  rankFiles,
  searchTermPlan,
  termsFor,
  dedupe
};
