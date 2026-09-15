'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { md5crypt, parseFiles, tag } = require('../src/webshare');

test('md5crypt matches Apache MD5-crypt reference vector', () => {
  assert.equal(md5crypt('password', 'salt1234'), '$1$salt1234$HJCsv4hSeVLHo3hVyl4nh0');
});

test('Webshare XML helpers parse search files', () => {
  const xml = `<?xml version="1.0"?><response><status>OK</status><total>2</total>
  <file><ident>abc123</ident><name>Movie.2026.CZ.1080p.mkv</name><type>mkv</type><size>123456</size><positive_votes>5</positive_votes><negative_votes>1</negative_votes><password>0</password></file>
  <file><ident>locked</ident><name>Locked.mkv</name><type>mkv</type><size>42</size><password>1</password></file></response>`;
  assert.equal(tag(xml, 'status'), 'OK');
  const files = parseFiles(xml);
  assert.equal(files.length, 1);
  assert.equal(files[0].id, 'abc123');
  assert.equal(files[0].name, 'Movie.2026.CZ.1080p.mkv');
  assert.equal(files[0].size, 123456);
  assert.equal(files[0].provider, 'webshare');
});
