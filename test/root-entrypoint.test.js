'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const compat = require('../server');
const guarded = require('../src/entrypoint');
const modular = require('../src/server');
const { VERSION } = require('../src/config');

test('root server.js delegates to the guarded modular production runtime', () => {
  assert.ok(compat.app);
  assert.equal(compat.app, guarded.app);
  assert.equal(guarded.app, modular.app);
  assert.equal(VERSION, '6.4.4');
});
