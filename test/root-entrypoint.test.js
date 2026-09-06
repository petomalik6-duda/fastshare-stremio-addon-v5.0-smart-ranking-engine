'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const compat = require('../server');
const launcher = require('../src/launcher');
const modular = require('../src/server');
const { VERSION } = require('../src/config');

test('root server.js and launcher delegate to the modular production runtime', () => {
  assert.ok(compat.app);
  assert.equal(compat.app, launcher.app);
  assert.equal(launcher.app, modular.app);
  assert.equal(VERSION, '6.4.4');
});
