'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const installFastSharePlayProxy = require('../src/fastshare-play-proxy');
const {
  isAllowedFastShareUrl,
  proxyMimeType
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

test('FastShare streams are replaced with same-origin opaque /play URLs', async () => {
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
      return '';
    }
  };
  const result = await runtime.buildStreamResponse(req, false);
  assert.match(result.streams[0].url, /^https:\/\/fastshare\.example\.test\/play\/[A-Za-z0-9_-]+$/);
  assert.equal(result.streams[0].url.includes('session='), false);
  assert.equal(result.streams[0].behaviorHints.notWebReady, false);
  assert.equal(routes.some(([method, path]) => method === 'GET' && path === '/play/:token'), true);
  assert.equal(routes.some(([method, path]) => method === 'HEAD' && path === '/play/:token'), true);
});
