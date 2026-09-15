'use strict';

const crypto = require('crypto');
const { VERSION } = require('./config');
const { normalize, getFreshCache, setCache, fetchWithTimeout } = require('./utils');

const API = 'https://webshare.cz/api';
const LOGIN_TIMEOUT_MS = Number(process.env.WEBSHARE_LOGIN_TIMEOUT_MS || 8000);
const SEARCH_TIMEOUT_MS = Number(process.env.WEBSHARE_SEARCH_TIMEOUT_MS || 8000);
const LINK_TIMEOUT_MS = Number(process.env.WEBSHARE_LINK_TIMEOUT_MS || 8000);
const SEARCH_CACHE_TTL_MS = Number(process.env.WEBSHARE_SEARCH_CACHE_TTL_MS || 1000 * 60 * 3);
const SEARCH_CACHE_MAX = Number(process.env.WEBSHARE_SEARCH_CACHE_MAX || 1000);
const AUTH_CACHE_TTL_MS = 1000 * 60 * 55;
const AUTH_CACHE_MAX = 200;
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const authCache = new Map();
const searchCache = new Map();

function md5(parts) {
  const h = crypto.createHash('md5');
  for (const part of parts) h.update(part);
  return h.digest();
}

function to64(value, count) {
  let out = '';
  let v = value >>> 0;
  while (count-- > 0) {
    out += ITOA64[v & 0x3f];
    v >>>= 6;
  }
  return out;
}

function md5crypt(password, saltInput) {
  const passwordBuf = Buffer.from(String(password || ''), 'utf8');
  const salt = String(saltInput || '').replace(/^\$1\$/, '').split('$')[0].slice(0, 8);
  const saltBuf = Buffer.from(salt, 'utf8');
  const magicBuf = Buffer.from('$1$', 'ascii');

  let initial = Buffer.concat([passwordBuf, magicBuf, saltBuf]);
  const alt = md5([passwordBuf, saltBuf, passwordBuf]);
  for (let left = passwordBuf.length; left > 0; left -= 16) {
    initial = Buffer.concat([initial, alt.subarray(0, Math.min(16, left))]);
  }
  for (let i = passwordBuf.length; i > 0; i >>= 1) {
    initial = Buffer.concat([initial, (i & 1) ? Buffer.from([0]) : passwordBuf.subarray(0, 1)]);
  }

  let final = md5([initial]);
  for (let i = 0; i < 1000; i++) {
    const parts = [];
    parts.push((i & 1) ? passwordBuf : final);
    if (i % 3) parts.push(saltBuf);
    if (i % 7) parts.push(passwordBuf);
    parts.push((i & 1) ? final : passwordBuf);
    final = md5(parts);
  }

  const b = final;
  let encoded = '';
  encoded += to64((b[0] << 16) | (b[6] << 8) | b[12], 4);
  encoded += to64((b[1] << 16) | (b[7] << 8) | b[13], 4);
  encoded += to64((b[2] << 16) | (b[8] << 8) | b[14], 4);
  encoded += to64((b[3] << 16) | (b[9] << 8) | b[15], 4);
  encoded += to64((b[4] << 16) | (b[10] << 8) | b[5], 4);
  encoded += to64(b[11], 2);
  return `$1$${salt}$${encoded}`;
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const match = String(xml || '').match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? xmlDecode(match[1].trim()) : '';
}

function parseFiles(xml) {
  return [...String(xml || '').matchAll(/<file>([\s\S]*?)<\/file>/gi)].map(match => {
    const block = match[1];
    const name = tag(block, 'name');
    return {
      id: tag(block, 'ident'),
      ident: tag(block, 'ident'),
      name,
      size: Number(tag(block, 'size') || 0),
      ext: tag(block, 'type') || (name.includes('.') ? name.split('.').pop() : ''),
      image: tag(block, 'img'),
      positiveVotes: Number(tag(block, 'positive_votes') || 0),
      negativeVotes: Number(tag(block, 'negative_votes') || 0),
      passwordProtected: tag(block, 'password') === '1',
      provider: 'webshare',
      raw: { xml: block }
    };
  }).filter(file => file.id && file.name && !file.passwordProtected);
}

async function post(endpoint, params, timeoutMs) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  const res = await fetchWithTimeout(`${API}/${endpoint}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'text/xml; charset=UTF-8',
      'User-Agent': `Stremio FastShare+Webshare/${VERSION}`
    },
    body
  }, timeoutMs);
  const text = await res.text();
  return { res, text };
}

async function login(creds) {
  const username = String(creds?.username || '').trim();
  const password = String(creds?.password || '');
  if (!username || !password) return { ok: false, error: 'missing credentials' };

  const key = crypto.createHash('sha1').update(`${username}:${password}`).digest('hex');
  const cached = getFreshCache(authCache, key, AUTH_CACHE_TTL_MS);
  if (cached) return { ok: true, token: cached.token, source: 'cache' };

  try {
    const saltResponse = await post('salt', { username_or_email: username }, LOGIN_TIMEOUT_MS);
    if (tag(saltResponse.text, 'status') !== 'OK') {
      return { ok: false, error: tag(saltResponse.text, 'message') || 'Webshare salt failed' };
    }
    const salt = tag(saltResponse.text, 'salt');
    const passwordHash = crypto.createHash('sha1').update(md5crypt(password, salt)).digest('hex');
    const digest = crypto.createHash('md5').update(`${username}:Webshare:${passwordHash}`).digest('hex');
    const loginResponse = await post('login', {
      username_or_email: username,
      password: passwordHash,
      digest,
      keep_logged_in: 1
    }, LOGIN_TIMEOUT_MS);
    if (tag(loginResponse.text, 'status') !== 'OK') {
      return { ok: false, error: tag(loginResponse.text, 'message') || 'Webshare login failed' };
    }
    const token = tag(loginResponse.text, 'token');
    if (!token) return { ok: false, error: 'Webshare login response has no token' };
    setCache(authCache, key, { token }, AUTH_CACHE_TTL_MS, AUTH_CACHE_MAX);
    return { ok: true, token, source: 'login' };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'Webshare login timeout' : String(error.message || error) };
  }
}

async function searchWebshare(term, token) {
  const cleanTerm = String(term || '').trim();
  if (!cleanTerm || !token) return { term: cleanTerm, status: 0, resultCount: 0, files: [], error: 'missing term or session' };
  const account = crypto.createHash('sha1').update(token).digest('hex').slice(0, 16);
  const cacheKey = `${account}:${normalize(cleanTerm)}`;
  const cached = getFreshCache(searchCache, cacheKey, SEARCH_CACHE_TTL_MS);
  if (cached) return { ...cached, cache: 'hit' };

  try {
    const { res, text } = await post('search', {
      what: cleanTerm,
      sort: 'rating',
      limit: 200,
      offset: 0,
      category: 'video',
      wst: token
    }, SEARCH_TIMEOUT_MS);
    const ok = res.ok && tag(text, 'status') === 'OK';
    const files = ok ? parseFiles(text) : [];
    const value = {
      term: cleanTerm,
      status: res.status,
      resultCount: files.length,
      total: Number(tag(text, 'total') || files.length),
      files,
      cache: 'miss',
      ...(ok ? {} : { error: tag(text, 'message') || `Webshare search HTTP ${res.status}` })
    };
    if (ok) {
      const { cache, ...cacheable } = value;
      setCache(searchCache, cacheKey, cacheable, SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX);
    }
    return value;
  } catch (error) {
    return {
      term: cleanTerm,
      status: 0,
      resultCount: 0,
      files: [],
      error: error?.name === 'AbortError' ? 'Webshare search timeout' : String(error.message || error),
      timedOut: error?.name === 'AbortError',
      cache: 'miss'
    };
  }
}

async function streamUrl(file, token) {
  const ident = file?.ident || file?.id;
  if (!ident || !token) return '';
  try {
    const { text } = await post('file_link', {
      ident,
      download_type: 'video_stream',
      force_https: 1,
      wst: token
    }, LINK_TIMEOUT_MS);
    if (tag(text, 'status') !== 'OK') return '';
    return tag(text, 'link');
  } catch {
    return '';
  }
}

module.exports = { login, searchWebshare, streamUrl, md5crypt, parseFiles, tag };
