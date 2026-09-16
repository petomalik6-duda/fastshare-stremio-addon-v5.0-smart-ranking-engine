'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const compat = require('../server');
const guarded = require('../src/entrypoint');
const modular = require('../src/server');
const { VERSION } = require('../src/config');
const { collapseSearchFiles } = require('../src/provider-recent-catalog');

test('root server.js delegates to the guarded unified production runtime', () => {
  assert.ok(compat.app);
  assert.equal(compat.app, guarded.app);
  assert.equal(guarded.app, modular.app);
  assert.equal(VERSION, '7.18.19');
});

test('search optimization collapses duplicate provider files but preserves two variants', () => {
  const rows = collapseSearchFiles([
    { name: 'Film 2026 1080p CZ.mkv' },
    { name: 'Film 2026 2160p CZ.mkv' },
    { name: 'Film 2026 720p CZ.mkv' },
    { name: 'Other 2025 CZ.mkv' }
  ]);
  assert.equal(rows.length, 3);
});
