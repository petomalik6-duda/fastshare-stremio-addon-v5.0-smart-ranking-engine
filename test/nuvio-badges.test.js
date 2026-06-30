const test = require('node:test');
const assert = require('node:assert/strict');
const { detectAudio, detectBadgeTags, streamObj } = require('../server');

test('normalizes common BetterFormatter/Nuvio badge tokens', () => {
  const name = 'Film.2026.2160p.WEB-DL.DV.HDR10Plus.HEVC.Atmos.DDP5.1.CZ.Dabing.mkv';
  const file = { name, size: 8 * 1024 ** 3, quality: '4K', audio: detectAudio(name), ext: 'MKV', durationText: '2:00:00' };
  const tags = detectBadgeTags(name, file);
  for (const expected of ['WEB-DL','2160p','DV','HDR10+','HEVC','Atmos','DD+','5.1','CZ']) {
    assert.ok(tags.includes(expected), `missing ${expected}: ${tags.join(', ')}`);
  }
});

test('recommended stream keeps badge tokens on the first line', () => {
  const name = 'Film.2026.1080p.BluRay.DTS-HD.MA.5.1.SK.Dabing.mkv';
  const file = { name, size: 5 * 1024 ** 3, quality: '1080p', audio: detectAudio(name), ext: 'MKV', durationText: '1:40:00', url: 'https://example.invalid/video.mkv' };
  const stream = streamObj(file, 'hash', true);
  const firstLine = stream.title.split('\n')[0];
  assert.match(firstLine, /Odporúčané/);
  assert.match(firstLine, /BluRay/);
  assert.match(firstLine, /1080p/);
  assert.match(firstLine, /DTS-HD MA/);
  assert.match(firstLine, /5\.1/);
  assert.match(firstLine, /SK/);
  assert.equal(stream.behaviorHints.filename, name);
  assert.equal(stream.behaviorHints.videoSize, file.size);
});

test('does not invent HDR or audio codec badges', () => {
  const name = 'Film.2026.720p.CZ.Dabing.mp4';
  const file = { name, quality: '720p', audio: detectAudio(name), ext: 'MP4', size: 1 };
  const tags = detectBadgeTags(name, file);
  assert.deepEqual(tags, ['720p', 'CZ', 'CZ AUDIO', 'DABING', 'MP4']);
});

test('adds explicit audio, dubbing, subtitle and container tokens', () => {
  const dubbed = 'Film.2026.1080p.WEB-DL.x265.CZ.Dabing.DDP5.1.10bit.mkv';
  const dubbedFile = { name: dubbed, quality: '1080p', audio: detectAudio(dubbed), ext: 'MKV' };
  const dubbedTags = detectBadgeTags(dubbed, dubbedFile);
  for (const expected of ['CZ', 'CZ AUDIO', 'DABING', 'HEVC', 'DD+', '5.1', '10bit', 'MKV']) {
    assert.ok(dubbedTags.includes(expected), `missing ${expected}: ${dubbedTags.join(', ')}`);
  }

  const subtitled = 'Film.2026.720p.WEBRip.CZ.titulky.mp4';
  const subtitleFile = { name: subtitled, quality: '720p', audio: detectAudio(subtitled), ext: 'MP4' };
  const subtitleTags = detectBadgeTags(subtitled, subtitleFile);
  assert.ok(subtitleTags.includes('CZ SUBS'));
  assert.ok(subtitleTags.includes('MP4'));
  assert.ok(!subtitleTags.includes('CZ AUDIO'));
});

test('extended Nuvio preset includes languages, subtitles, codecs and absolute images', () => {
  const { buildExtraNuvioFilters } = require('../server');
  const filters = buildExtraNuvioFilters('https://addon.example');
  const ids = new Set(filters.map(x => x.id));
  for (const id of ['fs-lang-cz','fs-lang-sk','fs-lang-en','fs-lang-multi','fs-subs-cz','fs-subs-sk','fs-codec-hevc','fs-codec-av1','fs-audio-aac','fs-container-mkv']) {
    assert.ok(ids.has(id), `missing filter ${id}`);
  }
  assert.ok(filters.every(x => x.imageURL.startsWith('https://addon.example/badges/')));
});

test('merged badge preset preserves base filters and appends addon filters once', () => {
  const { buildExtraNuvioFilters, mergeNuvioBadgeFilters } = require('../server');
  const base = [{ id: 'q-r', name: 'Remux' }, { id: 'q-w', name: 'WebDL' }];
  const extra = buildExtraNuvioFilters('https://addon.example');
  const merged = mergeNuvioBadgeFilters(base, extra.concat(extra[0]));
  assert.deepEqual(merged.slice(0, 2), base);
  assert.equal(merged.filter(x => x.id === 'fs-recommended').length, 1);
  assert.ok(merged.some(x => x.id === 'fs-lang-cz'));
});
