/*
FastShare v6.1 general patch

Pouzitie:
1) Otvor svoj funkcny server.js z v6.1.
2) Nahrad detectAudio() verziou nizsie.
3) Do scoreFile() dopln helpery extractYearFromName(), getMetaYear(), titleStrength(), yearPenalty().
4) V scoreFile() nahrad tvrde different-year minus pravidlom yearPenalty().
*/

// ---------- 1) STRICT SUBTITLES / AUDIO FIX ----------
function detectAudio(name) {
  const n = normalize(name);

  const czSubs = /\b(cz\s*tit|cztit|cz\s*titulky|cz\s*sub|cz\s*subs|cz\s*subtitle|cz\s*title|czforced|czech\s*subs|ceske\s*titulky)\b/.test(n);
  const skSubs = /\b(sk\s*tit|sktit|sk\s*titulky|sk\s*sub|sk\s*subs|sk\s*subtitle|sk\s*title|slovak\s*subs|slovenske\s*titulky)\b/.test(n);

  const hasCzDub = /\b(cz\s*dab|czdab|cz\s*dabing|czech\s*(audio|dub|dabing)|cesky\s*dabing|cze\s*(audio|dub))\b/.test(n);
  const hasSkDub = /\b(sk\s*dab|skdab|sk\s*dabing|slovak\s*(audio|dub|dabing)|slovensky\s*dabing|svk\s*(audio|dub))\b/.test(n);

  const hasEn = /\b(en|eng|english)\b/.test(n) || /\b(en|eng)\s*(audio|dabing|dub)\b/.test(n);
  const hasCzToken = /\b(cz|cze|ces|cs|czech)\b/.test(n);
  const hasSkToken = /\b(sk|svk|slovak)\b/.test(n);

  let label = 'Audio nezname';
  let lang = 'any';
  let score = 0;

  // CZ/SK titulky samotne nikdy nesmu znamenat CZ/SK audio.
  if (hasCzDub) { label = 'CZ Dabing'; lang = 'CZ'; score = 110; }
  else if (hasSkDub) { label = 'SK Dabing'; lang = 'SK'; score = 90; }
  else if (hasCzToken && hasEn && !czSubs) { label = 'CZ/EN Audio'; lang = 'CZEN'; score = 80; }
  else if (hasSkToken && hasEn && !skSubs) { label = 'SK/EN Audio'; lang = 'SKEN'; score = 65; }
  else if (hasEn) { label = 'EN Audio'; lang = 'EN'; score = 35; }
  else if (/\b(multi\s*audio|dual\s*audio|dual)\b/.test(n)) { label = 'Multi Audio'; lang = 'MULTI'; score = 25; }
  else if (czSubs) { label = 'CZ titulky'; lang = 'SUB'; score = 5; }
  else if (skSubs) { label = 'SK titulky'; lang = 'SUB'; score = 5; }
  else if (hasCzToken) { label = 'CZ neoverene'; lang = 'CZ'; score = 15; }
  else if (hasSkToken) { label = 'SK neoverene'; lang = 'SK'; score = 12; }

  const subs = [];
  if (czSubs && label !== 'CZ titulky') subs.push('CZ titulky');
  if (skSubs && label !== 'SK titulky') subs.push('SK titulky');

  if (czSubs && label !== 'CZ titulky') score += 18;
  if (skSubs && label !== 'SK titulky') score += 12;

  return { label, lang, subs, score };
}

// ---------- 2) GENERAL YEAR SCORING FIX ----------
function extractYearFromName(name) {
  const m = normalize(name).match(/\b(19\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : 0;
}

function getMetaYear(meta) {
  const raw = String(meta.year || meta.releaseInfo || '');
  const m = raw.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : 0;
}

function titleStrength(fileName, meta) {
  const n = normalize(fileName);
  const title = normalize(meta.title || meta.name || '');
  if (!title) return false;
  if (n.includes(title)) return true;

  const stop = new Set(['the','a','an','and','or','of','to','in','on','at','with','for','from']);
  const tw = title.split(/\s+/).filter(w => w.length > 2 && !stop.has(w));
  if (!tw.length) return false;
  const matched = tw.filter(w => n.includes(w)).length;
  return matched >= 2 || matched / tw.length >= 0.67;
}

function yearPenalty(fileName, meta, strongTitle) {
  const fileYear = extractYearFromName(fileName);
  const metaYear = getMetaYear(meta);

  if (!fileYear || !metaYear) return { value: 0, reason: 'no-year-penalty' };
  if (fileYear === metaYear) return { value: 60, reason: 'year +60' };

  const diff = Math.abs(fileYear - metaYear);

  if (strongTitle && diff === 1) {
    return { value: -20, reason: 'year-off-by-1-strong-title -20' };
  }

  if (strongTitle && diff <= 2) {
    return { value: -45, reason: 'year-off-by-2-strong-title -45' };
  }

  if (!strongTitle) {
    return { value: -220, reason: 'different-year-weak-title -220' };
  }

  return { value: -80, reason: 'different-year-strong-title -80' };
}

/*
V scoreFile() pouzi takto:

const strongTitle = titleStrength(file.name, meta);
const yp = yearPenalty(file.name, meta, strongTitle);
score += yp.value;
scoreReasons.push(yp.reason);

A zmaz alebo zakomentuj stare tvrde pravidlo:
if (meta.year && y && y[1] !== meta.year) {
  score -= 200;
}
*/
