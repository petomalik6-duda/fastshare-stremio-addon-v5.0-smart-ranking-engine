'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const runtime = require('../src/entrypoint');
const { VERSION } = require('../src/config');

test('complete production runtime serves manifest, health and installed compatibility layers', async () => {
  const server = runtime.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = async path => {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const [health, manifest, deployment] = await Promise.all([
      read('/health'), read('/manifest.json'), read('/deploy-info')
    ]);
    assert.equal(health.ok, true);
    assert.equal(manifest.version, VERSION);
    assert.ok(manifest.resources.some(r => (typeof r === 'string' ? r : r.name) === 'stream'));
    assert.equal(deployment.entrypoint, 'src/entrypoint.js');
    for (const flag of ['catalogFinalizer', 'combinedProviderStreams', 'fastShareWebPlaybackProxy', 'peopleFilmographyBridge']) {
      assert.equal(deployment[flag], true, flag);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
