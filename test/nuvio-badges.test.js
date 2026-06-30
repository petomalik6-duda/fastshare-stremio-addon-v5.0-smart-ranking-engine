const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectAudio,
  detectBadgeTags,
  streamObj,
  buildExtraNuvioFilters,
  adaptNardBadgeFilters,
  mergeNuvioBadgeFilters,
  NARD_BADGES_URL
} = require('../server');

test('normalizes common Nuvio/Nard badge tokens', () => {
  const name = 'Film.2026.2160p.WEB-DL.DV.HDR10Plus.HEVC.Atmos.DDP5.1.CZ.Dabing.mkv';
  const file = { name, size: 8 * 1024 ** 3, quality: '4K', audio: detectAudio(name), ext: 'MKV', durationText: '2:00:00' };
  const tags = detectBadgeTags(name, file);
  for (const expected of ['WEB-DL','2160p','DV','HDR10+','HEVC','Atmos','DD+','5.1','CZ','CZ AUDIO','DABING','MKV']) {
    assert.ok(tags.includes(expected), `missing ${expected}: ${tags.join(', ')}`);
  }
});

test('recommended stream keeps all badge tokens on the first line', () => {
  const name = 'Film.2026.1080p.BluRay.DTS-HD.MA.5.1.SK.Dabing.mkv';
  const file = { name, size: 5 * 1024 ** 3, quality: '1080p', audio: detectAudio(name), ext: 'MKV', durationText: '1:40:00', url: 'https://example.invalid/video.mkv' };
  const stream = streamObj(file, 'hash', true);
  const firstLine = stream.title.split('\n')[0];
  for (const expected of [/Odporúčané/, /BluRay/, /1080p/, /DTS-HD MA/, /5\.1/, /SK/, /DABING/, /MKV/]) assert.match(firstLine, expected);
  assert.equal(stream.behaviorHints.filename, name);
  assert.equal(stream.behaviorHints.videoSize, file.size);
});

test('does not invent HDR or audio codec badges', () => {
  const name = 'Film.2026.720p.CZ.Dabing.mp4';
  const file = { name, quality: '720p', audio: detectAudio(name), ext: 'MP4', size: 1 };
  assert.deepEqual(detectBadgeTags(name, file), ['720p', 'CZ', 'CZ AUDIO', 'DABING', 'MP4']);
});

test('subtitle-only files do not create an audio language badge', () => {
  const name = 'Film.2026.720p.WEBRip.CZ.titulky.mp4';
  const file = { name, quality: '720p', audio: detectAudio(name), ext: 'MP4' };
  const tags = detectBadgeTags(name, file);
  assert.ok(tags.includes('CZ SUBS'));
  assert.ok(tags.includes('MP4'));
  assert.ok(!tags.includes('CZ AUDIO'));
});

test('uses NardBadges as the default upstream design', () => {
  assert.equal(NARD_BADGES_URL, 'https://raw.githubusercontent.com/vowl313/NardBadges/refs/heads/main/NardBadges.json');
});

test('adapts Nard language filters to addon CZ/SK/EN/MULTI tokens', () => {
  const input = [
    { id: 'f1', name: 'CZE', pattern: 'old-cz' },
    { id: 'f2', name: 'SVK', pattern: 'old-sk' },
    { id: 'l-en', name: 'ENG', pattern: 'old-en' },
    { id: 'l-mu', name: 'MUL', pattern: 'old-multi' },
    { id: 'r-4k', name: '4K', pattern: 'keep-me' }
  ];
  const out = adaptNardBadgeFilters(input);
  assert.match(out[0].pattern, /CZ\|CZE/);
  assert.match(out[1].pattern, /SK\|SVK/);
  assert.match(out[2].pattern, /EN\|ENG/);
  assert.match(out[3].pattern, /MULTI\|MUL/);
  assert.equal(out[4].pattern, 'keep-me');
});

test('local gap filters use transparent Nard-style badges', () => {
  const filters = buildExtraNuvioFilters('https://addon.example');
  const ids = new Set(filters.map(x => x.id));
  for (const id of ['fs-nard-recommended','fs-nard-dabing','fs-nard-subs-cz','fs-nard-subs-sk','fs-nard-res-480','fs-nard-container-mkv','fs-nard-container-mp4']) {
    assert.ok(ids.has(id), `missing filter ${id}`);
  }
  assert.ok(filters.every(x => x.imageURL.startsWith('https://addon.example/badges/nard-')));
  assert.ok(filters.every(x => x.tagColor === '#00000000'));
  assert.ok(filters.every(x => x.textColor === '#FFFFFF'));
  assert.ok(filters.every(x => x.tagStyle === 'filled and bordered'));
});

test('merged badge preset preserves base filters and de-duplicates ids and names', () => {
  const base = [{ id: 'q-r', name: 'Remux' }, { id: 'q-w', name: 'WebDL' }];
  const extra = buildExtraNuvioFilters('https://addon.example');
  const duplicateName = { id: 'other-webdl', name: 'WebDL' };
  const merged = mergeNuvioBadgeFilters(base, [duplicateName, ...extra, extra[0]]);
  assert.deepEqual(merged.slice(0, 2), base);
  assert.equal(merged.filter(x => x.id === 'fs-nard-recommended').length, 1);
  assert.equal(merged.filter(x => x.name === 'WebDL').length, 1);
});

test('bare CZ token does not become a verified audio badge (Citizen Vigilante regression)', () => {
  const name = 'Citizen.Vigilante.2025.CZ.1080p.WEB-DL.x264.mkv';
  const audio = detectAudio(name);
  const file = { name, quality: '1080p', audio, ext: 'MKV' };
  const tags = detectBadgeTags(name, file);
  assert.equal(audio.key, 'any');
  assert.equal(audio.verifiedAudio, false);
  assert.equal(audio.evidence, 'bare-language-token');
  assert.ok(!tags.includes('CZ'));
  assert.ok(!tags.includes('CZ AUDIO'));
});

test('CZ next to an audio codec is accepted as verified audio', () => {
  const name = 'Film.2026.1080p.WEB-DL.CZ.AC3.5.1.mkv';
  const audio = detectAudio(name);
  const tags = detectBadgeTags(name, { name, quality: '1080p', audio, ext: 'MKV' });
  assert.equal(audio.key, 'CZ');
  assert.equal(audio.verifiedAudio, true);
  assert.equal(audio.evidence, 'audio-codec');
  assert.ok(tags.includes('CZ AUDIO'));
});

test('adapted Nard language filters require explicit AUDIO token', () => {
  const input = [{ id: 'f1', name: 'CZE', pattern: 'old' }];
  const [filter] = adaptNardBadgeFilters(input);
  assert.match(filter.pattern, /\\s\+AUDIO/);
  assert.doesNotMatch(filter.pattern, /AUDIO\)\?/);
});
