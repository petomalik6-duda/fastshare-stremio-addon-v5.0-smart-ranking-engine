'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const installFastSharePlayProxy = require('../src/fastshare-play-proxy');
const {
  isAllowedFastShareUrl,
  proxyMimeType,
  playbackFilename,
  iosContainerPriority,
  isAppleMobileRequest
} = require('../src/fastshare-play-proxy');

test('FastShare playback proxy only accepts FastShare HTTPS hosts', () => {
  assert.equal(isAllowedFastShareUrl('https://fastshare.cz/file.mp4'), true);
  assert.equal(isAllowedFastShareUrl('https://data12.fastshare.cloud/file.mp4'), true);
  assert.equal(isAllowedFastShareUrl('http://data12.fastshare.cloud/file.mp4'), false);
  assert.equal(isAllowedFastShareUrl('https://fastshare.cloud.evil.example/file.mp4'), false);
  assert.equal(isAllowedFastShareUrl('https://example.com/file.mp4'), false);
});

test('FastShare playback proxy provides Safari-friendly MIME fallbacks', () => {
  assert.equal(proxyMimeType('movie.mp4', 'application/octet-stream'), 'video/mp4');
  assert.equal(proxyMimeType('movie.m4v', ''), 'video/mp4');
  assert.equal(proxyMimeType('movie.mov', ''), 'video/quicktime');
  assert.equal(proxyMimeType('movie.mkv', ''), 'video/x-matroska');
  assert.equal(proxyMimeType('movie.mp4', 'video/mp4; charset=binary'), 'video/mp4');
});

test('iOS container helpers prefer MP4 and sanitize playback filenames', () => {
  assert.equal(playbackFilename('../../Movie 2026 CZ.mp4'), 'Movie 2026 CZ.mp4');
  assert.equal(iosContainerPriority('Movie.mp4') < iosContainerPriority('Movie.mkv'), true);
  assert.equal(isAppleMobileRequest({ get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)' }), true);
  assert.equal(isAppleMobileRequest({ get: () => 'Mozilla/5.0 (Linux; Android 16)' }), false);
});

test('FastShare streams are replaced with filename-aware same-origin /play URLs', async () => {
  const routes = [];
  const runtime = {
    app: {
      get(path, handler) { routes.push(['GET', path, handler]); },
      head(path, handler) { routes.push(['HEAD', path, handler]); }
    },
    async buildStreamResponse() {
      return {
        streams: [{
          name: 'FastShare CZ',
          title: 'Movie',
          url: 'https://data12.fastshare.cloud/video.mp4?stream=1&session=secret',
          behaviorHints: { filename: 'Movie.2026.CZ.1080p.mp4' }
        }]
      };
    }
  };

  installFastSharePlayProxy(runtime);
  const req = {
    protocol: 'https',
    get(name) {
      if (name === 'x-forwarded-proto') return 'https';
      if (name === 'x-forwarded-host') return 'fastshare.example.test';
      if (name === 'user-agent') return 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)';
      return '';
    }
  };
  const result = await runtime.buildStreamResponse(req, false);
  assert.match(
    result.streams[0].url,
    /^https:\/\/fastshare\.example\.test\/play\/[A-Za-z0-9_-]+\/Movie\.2026\.CZ\.1080p\.mp4$/
  );
  assert.equal(result.streams[0].url.includes('session='), false);
  assert.equal(result.streams[0].behaviorHints.notWebReady, false);
  assert.equal(result.streams[0].behaviorHints.webPlaybackContainer, 'mp4');
  assert.equal(result.streams[0].behaviorHints.webPlaybackPreferred, true);
  assert.equal(routes.some(([method, path]) => method === 'GET' && path === '/play/:token/:filename?'), true);
  assert.equal(routes.some(([method, path]) => method === 'HEAD' && path === '/play/:token/:filename?'), true);
});

test('iPhone requests prefer MP4 over MKV without removing MKV fallback', async () => {
  const runtime = {
    app: { get() {}, head() {} },
    async buildStreamResponse() {
      return {
        streams: [
          {
            name: 'FastShare CZ',
            url: 'https://data12.fastshare.cloud/movie.mkv?stream=1&session=secret',
            behaviorHints: { filename: 'Movie.2026.CZ.1080p.mkv' }
          },
          {
            name: 'FastShare CZ',
            url: 'https://data12.fastshare.cloud/movie.mp4?stream=1&session=secret',
            behaviorHints: { filename: 'Movie.2026.CZ.1080p.mp4' }
          }
        ]
      };
    }
  };
  installFastSharePlayProxy(runtime);
  const req = {
    protocol: 'https',
    get(name) {
      if (name === 'x-forwarded-host') return 'fastshare.example.test';
      if (name === 'x-forwarded-proto') return 'https';
      if (name === 'user-agent') return 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)';
      return '';
    }
  };
  const result = await runtime.buildStreamResponse(req, false);
  assert.equal(result.streams.length, 2);
  assert.equal(result.streams[0].behaviorHints.filename.endsWith('.mp4'), true);
  assert.equal(result.streams[1].behaviorHints.filename.endsWith('.mkv'), true);
});
