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
  assert.deepEqual(tags, ['720p', 'CZ']);
});
