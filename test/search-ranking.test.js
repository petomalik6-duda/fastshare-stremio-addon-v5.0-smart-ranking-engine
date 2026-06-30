const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectAudio,
  getTitleAliases,
  titleMatchScore,
  scoreFile,
  termsFor
} = require('../server');

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

test('search terms contain localized and stemmed variants', () => {
  const terms = termsFor(meta).map(x => x.toLowerCase());
  assert.ok(terms.includes('dabel nosi pradu 2'));
  assert.ok(terms.includes('diabol nosi pradu 2'));
  assert.ok(terms.includes('pradu 2'));
  assert.ok(terms.includes('prad 2'));
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

const {
  extractTmdbLocalizedAliases,
  extractWikidataLocalizedAliases
} = require('../server');

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
  assert.ok(terms.includes('alternatívny český názov'));
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

test('series search keeps exact localized episode terms before broad variants', () => {
  const seriesMeta = {
    type: 'series',
    imdbId: 'tt0944947',
    title: 'Game of Thrones',
    season: 1,
    episode: 2,
    raw: {},
    localizedAliases: ['Hra o trůny', 'Hra o tróny']
  };
  const terms = termsFor(seriesMeta).map(x => x.toLowerCase());
  assert.ok(terms.includes('hra o trůny s01e02'));
  assert.ok(terms.includes('hra o trony s01e02'));
  assert.ok(terms.includes('game of thrones s01e02'));
});
