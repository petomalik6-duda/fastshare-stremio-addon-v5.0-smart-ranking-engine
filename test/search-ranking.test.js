'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectAudio,
  getTitleAliases,
  fuzzyTokenMatch,
  titleMatchScore,
  scoreFile,
  rankFiles,
  seriesCandidateKind,
  searchTermPlan,
  termsFor
} = require('../src/ranking');
const {
  extractTmdbLocalizedAliases,
  extractWikidataLocalizedAliases
} = require('../src/metadata');

const meta = {
  type: 'movie',
  imdbId: 'tt33612209',
  stremioId: 'tt33612209',
  title: 'The Devil Wears Prada 2',
  year: '2026',
  raw: { name: 'The Devil Wears Prada 2' }
};

test('adds Czech and Slovak aliases for The Devil Wears Prada 2', () => {
  const aliases = getTitleAliases(meta).map(x => x.toLowerCase());
  assert.ok(aliases.includes('dabel nosi pradu 2'));
  assert.ok(aliases.includes('diabol nosi pradu 2'));
});

test('main metadata title is pinned before a large localized alias list', () => {
  const manyAliases = Array.from({ length: 30 }, (_, i) => `Alias ${i + 1}`);
  const genericMeta = {
    type: 'movie',
    imdbId: 'tt1234567',
    title: 'Canonical Main Title',
    year: '2026',
    raw: { name: 'Canonical Main Title' },
    localizedAliases: manyAliases,
    localizedTitleData: {
      aliasDetails: [
        { title: 'Český názov', language: 'cs', source: 'tmdb' },
        { title: 'Slovenský názov', language: 'sk', source: 'tmdb' }
      ]
    }
  };
  const aliases = getTitleAliases(genericMeta);
  assert.equal(aliases[0], 'Canonical Main Title');
  assert.ok(aliases.includes('Český názov'));
  assert.ok(aliases.includes('Slovenský názov'));
});

test('fuzzy matching keeps Czech inflection but removes the four-letter-prefix shortcut', () => {
  assert.equal(fuzzyTokenMatch('prada', 'pradu'), true);
  assert.equal(fuzzyTokenMatch('planet', 'planner'), false);
  assert.equal(fuzzyTokenMatch('tuner', 'tunes'), false);
});

test('search terms contain localized and stemmed sequel variants', () => {
  const terms = termsFor(meta).map(x => x.toLowerCase());
  assert.ok(terms.includes('dabel nosi pradu 2'));
  assert.ok(terms.includes('diabol nosi pradu 2'));
  assert.ok(terms.includes('pradu 2'));
  assert.ok(terms.includes('prad 2'));
});

test('two-stage movie plan keeps the primary stage small and the broad variants in fallback', () => {
  const plan = searchTermPlan(meta);
  assert.ok(plan.primary.length <= 6);
  assert.ok(plan.primary.some(x => /2026/.test(x)));
  assert.ok(plan.fallback.length > 0);
  assert.ok(plan.fallback.some(x => x.toLowerCase() === 'prad 2'));
});

test('accepts correctly localized sequel with CZ dubbing', () => {
  const file = {
    name: 'Dabel.nosi.Pradu.2.2026.CZ.Dabing.1080p.mkv',
    size: 5 * 1024 ** 3
  };
  const scored = scoreFile(file, meta, 'movie');
  assert.ok(scored);
  assert.ok(scored.score > 200, `score was ${scored.score}`);
  assert.equal(scored.audio.key, 'CZ');
});

test('accepts Slovak localized sequel and fuzzy Prada/Pradu inflection', () => {
  const match = titleMatchScore('Diabol nosi Pradu 2 2026 SK dabing 1080p.mkv', meta, 'movie');
  assert.equal(match.reject, false);
  assert.ok(match.score >= 150, `score was ${match.score}`);
});

test('rejects the original 2006 film when requesting sequel', () => {
  const match = titleMatchScore('Dabel.nosi.Pradu.2006.CZ.Dabing.1080p.mkv', meta, 'movie');
  assert.equal(match.reject, true);
});

test('unqualified dabing is recognized without falsely claiming CZ', () => {
  const audio = detectAudio('Dabel nosi Pradu 2 2026 dabing 1080p.mkv');
  assert.equal(audio.key, 'dub');
  assert.equal(audio.score, 55);
});

test('rejects a different sequel number', () => {
  const match = titleMatchScore('Dabel.nosi.Pradu.3.2026.CZ.Dabing.1080p.mkv', meta, 'movie');
  assert.equal(match.reject, true);
});

test('uses automatic localized aliases for an arbitrary movie, not only a built-in IMDb ID', () => {
  const genericMeta = {
    type: 'movie',
    imdbId: 'tt0099785',
    title: 'Home Alone',
    year: '1990',
    raw: { name: 'Home Alone' },
    localizedAliases: ['Sám doma', 'Sám doma 1']
  };
  const terms = termsFor(genericMeta).map(x => x.toLowerCase());
  assert.ok(terms.includes('sám doma'));
  const match = titleMatchScore('Sam.doma.1990.CZ.Dabing.1080p.mkv', genericMeta, 'movie');
  assert.equal(match.reject, false);
  assert.ok(match.score >= 150, `score was ${match.score}`);
});

test('extracts Czech and Slovak titles from TMDB payloads', () => {
  const aliases = extractTmdbLocalizedAliases('movie', [{
    title: 'Sám doma',
    original_title: 'Home Alone',
    __language: 'cs',
    alternative_titles: {
      titles: [
        { iso_3166_1: 'CZ', title: 'Sám doma' },
        { iso_3166_1: 'SK', title: 'Sám doma' },
        { iso_3166_1: 'DE', title: 'Kevin – Allein zu Haus' }
      ]
    },
    translations: {
      translations: [
        { iso_639_1: 'sk', iso_3166_1: 'SK', data: { title: 'Sám doma' } },
        { iso_639_1: 'de', iso_3166_1: 'DE', data: { title: 'Kevin – Allein zu Haus' } }
      ]
    }
  }]).map(x => x.title);
  assert.ok(aliases.includes('Sám doma'));
  assert.ok(aliases.includes('Home Alone'));
  assert.equal(aliases.includes('Kevin – Allein zu Haus'), false);
});

test('extracts Czech, Slovak and English labels from Wikidata response', () => {
  const aliases = extractWikidataLocalizedAliases({
    results: {
      bindings: [
        { label: { value: 'Sám doma', 'xml:lang': 'cs' } },
        { label: { value: 'Home Alone', 'xml:lang': 'en' } },
        { altLabel: { value: 'Sám doma 1', 'xml:lang': 'sk' } },
        { label: { value: 'Kevin – Allein zu Haus', 'xml:lang': 'de' } }
      ]
    }
  }).map(x => x.title);
  assert.deepEqual(aliases.sort(), ['Home Alone', 'Sám doma', 'Sám doma 1'].sort());
});

test('keeps full localized titles before shortened variants when search limit is applied', () => {
  const genericMeta = {
    type: 'movie',
    imdbId: 'tt1234567',
    title: 'English Main Title',
    year: '2026',
    raw: {},
    localizedAliases: [
      'Český lokalizovaný názov',
      'Slovenský lokalizovaný názov',
      'Alternatívny český názov'
    ]
  };
  const terms = termsFor(genericMeta).map(x => x.toLowerCase());
  assert.ok(terms.includes('český lokalizovaný názov'));
  assert.ok(terms.includes('slovenský lokalizovaný názov'));
  assert.ok(terms.includes('english main title'));
});

test('adds a no-diacritics search variant for localized titles', () => {
  const genericMeta = {
    type: 'movie',
    imdbId: 'tt0099785',
    title: 'Home Alone',
    year: '1990',
    raw: {},
    localizedAliases: ['Sám doma']
  };
  const terms = termsFor(genericMeta).map(x => x.toLowerCase());
  assert.ok(terms.includes('sám doma'));
  assert.ok(terms.includes('sam doma'));
});

const seriesMeta = {
  type: 'series',
  imdbId: 'tt0944947',
  title: 'Game of Thrones',
  season: 1,
  episode: 2,
  raw: {},
  localizedAliases: ['Hra o trůny', 'Hra o tróny']
};

test('series primary stage covers localized exact episode names before broad variants', () => {
  const plan = searchTermPlan(seriesMeta);
  const primary = plan.primary.map(x => x.toLowerCase());
  assert.ok(primary.includes('game of thrones s01e02'));
  assert.ok(primary.includes('hra o trůny s01e02'));
  assert.ok(primary.includes('hra o tróny s01e02'));
  assert.ok(plan.fallback.length > 0);
});

test('recognizes multi-episode files containing the requested episode', () => {
  const name = 'Hra.o.truny.S01E01E02.1080p.CZ.Dabing.mkv';
  assert.equal(seriesCandidateKind(name, seriesMeta), 'multi-episode');
  const scored = scoreFile({ name, size: 4 * 1024 ** 3 }, seriesMeta, 'series');
  assert.ok(scored);
  assert.equal(scored.seriesKind, 'multi-episode');
});

test('rejects an explicitly different series episode', () => {
  const wrong = scoreFile({
    name: 'Hra.o.truny.S01E03.1080p.CZ.Dabing.mkv',
    size: 4 * 1024 ** 3
  }, seriesMeta, 'series');
  assert.equal(wrong, null);
});

test('season packs are fallback only when a standalone episode exists', () => {
  const exact = {
    name: 'Hra.o.truny.S01E02.1080p.CZ.Dabing.mkv',
    size: 4 * 1024 ** 3
  };
  const pack = {
    name: 'Hra.o.truny.S01.Complete.1080p.CZ.Dabing.mkv',
    size: 20 * 1024 ** 3
  };
  assert.equal(seriesCandidateKind(pack.name, seriesMeta), 'season-pack');
  const ranked = rankFiles([pack, exact], seriesMeta, 'series');
  assert.ok(ranked.length >= 1);
  assert.ok(ranked.every(x => ['exact-episode', 'multi-episode'].includes(x.seriesKind)));
});

test('season pack remains available when no standalone episode is found', () => {
  const pack = {
    name: 'Hra.o.truny.S01.Complete.1080p.CZ.Dabing.mkv',
    size: 20 * 1024 ** 3
  };
  const ranked = rankFiles([pack], seriesMeta, 'series');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].seriesKind, 'season-pack');
});

test('rejects Lonely Tunes when the requested one-word movie is Tuner', () => {
  const tunerMeta = {
    type: 'movie',
    imdbId: 'tt0000001',
    title: 'Tuner',
    year: '2025',
    raw: { name: 'Tuner' },
    localizedAliases: []
  };
  const wrong = scoreFile({
    name: 'Lonely.Tunes.2025.CZ.Dabing.2160p.mkv',
    size: 12 * 1024 ** 3
  }, tunerMeta, 'movie');
  assert.equal(wrong, null);
});

test('keeps an exact one-word title match for Tuner', () => {
  const tunerMeta = {
    type: 'movie',
    imdbId: 'tt0000001',
    title: 'Tuner',
    year: '2025',
    raw: { name: 'Tuner' },
    localizedAliases: []
  };
  const correct = scoreFile({
    name: 'Tuner.2025.CZ.Dabing.1080p.mkv',
    size: 5 * 1024 ** 3
  }, tunerMeta, 'movie');
  assert.ok(correct);
  assert.ok(correct.score > 200, `score was ${correct.score}`);
});

test('does not generate a broad four-letter stem for a one-word movie title', () => {
  const tunerMeta = {
    type: 'movie',
    imdbId: 'tt0000001',
    title: 'Tuner',
    year: '2025',
    raw: { name: 'Tuner' },
    localizedAliases: []
  };
  const terms = termsFor(tunerMeta).map(x => x.toLowerCase());
  assert.ok(terms.includes('tuner'));
  assert.equal(terms.includes('tune'), false);
});

const sadeMeta = {
  type: 'movie',
  imdbId: 'tt3509240',
  stremioId: 'tt3509240',
  title: 'Sade: Bring Me Home - Live 2011',
  year: '2012',
  raw: { name: 'Sade: Bring Me Home - Live 2011' },
  localizedAliases: []
};

test('rejects a different Sade live concert that only matches artist plus Live', () => {
  const wrong = scoreFile({
    name: 'Sade.Live.1994.1080p.BluRay.mkv',
    size: 9 * 1024 ** 3
  }, sadeMeta, 'movie');
  assert.equal(wrong, null);
});

test('rejects a generic Sade Live result even when it contains the title year', () => {
  const wrong = scoreFile({
    name: 'Sade.Live.2011.Full.Concert.1080p.mkv',
    size: 10 * 1024 ** 3
  }, sadeMeta, 'movie');
  assert.equal(wrong, null);
});

test('accepts the correct Sade Bring Me Home Live concert', () => {
  const correct = scoreFile({
    name: 'Sade.Bring.Me.Home.Live.2011.1080p.BluRay.mkv',
    size: 12 * 1024 ** 3
  }, sadeMeta, 'movie');
  assert.ok(correct);
  assert.ok(correct.score >= 200, `score was ${correct.score}`);
});

test('does not generate broad live or home-only search terms for concert titles', () => {
  const terms = termsFor(sadeMeta).map(x => x.toLowerCase());
  assert.ok(terms.includes('sade: bring me home - live 2011'));
  assert.equal(terms.includes('live'), false);
  assert.equal(terms.includes('home'), false);
  assert.equal(terms.some(x => x.includes('2011 2012')), false);
});
