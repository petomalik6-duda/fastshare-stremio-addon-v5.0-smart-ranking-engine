'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');

const TOKEN_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.FASTSHARE_PLAY_TOKEN_TTL_MS || 2 * 60 * 60 * 1000));
const TOKEN_MAX = Math.max(100, Number(process.env.FASTSHARE_PLAY_TOKEN_MAX || 5000));
const proxyTargets = new Map();

function publicBaseUrl(req) {
  const forwarded = String(req?.get?.('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwarded || req?.protocol || 'https';
  const host = String(req?.get?.('x-forwarded-host') || req?.get?.('host') || '').split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}

function isAllowedFastShareUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'fastshare.cz' || host.endsWith('.fastshare.cz') ||
      host === 'fastshare.cloud' || host.endsWith('.fastshare.cloud');
  } catch {
    return false;
  }
}

function proxyMimeType(filename = '', upstreamType = '') {
  const upstream = String(upstreamType || '').split(';')[0].trim().toLowerCase();
  if (upstream && upstream !== 'application/octet-stream' && upstream !== 'binary/octet-stream') {
    return upstream;
  }
  const clean = String(filename || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.ts') || clean.endsWith('.m2ts')) return 'video/mp2t';
  if (clean.endsWith('.mkv')) return 'video/x-matroska';
  if (clean.endsWith('.avi')) return 'video/x-msvideo';
  return upstream || 'application/octet-stream';
}

function playbackFilename(filename = '') {
  const raw = String(filename || '').split(/[\\/]/).pop() || 'video';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._()\[\] -]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-180);
  return cleaned || 'video';
}

function fileExtension(filename = '') {
  const match = playbackFilename(filename).toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return match ? match[1] : '';
}

function iosContainerPriority(filename = '') {
  const ext = fileExtension(filename);
  if (['mp4', 'm4v', 'mov'].includes(ext)) return 0;
  if (['ts', 'm2ts', 'webm'].includes(ext)) return 1;
  if (!ext) return 2;
  if (['mkv', 'avi', 'wmv'].includes(ext)) return 4;
  return 3;
}

function isAppleMobileRequest(req) {
  const userAgent = String(req?.get?.('user-agent') || '').toLowerCase();
  return /iphone|ipad|ipod/.test(userAgent) || (userAgent.includes('macintosh') && userAgent.includes('mobile'));
}

function cleanupTargets(now = Date.now()) {
  for (const [token, entry] of proxyTargets) {
    if (!entry || entry.expiresAt <= now) proxyTargets.delete(token);
  }
  while (proxyTargets.size > TOKEN_MAX) {
    proxyTargets.delete(proxyTargets.keys().next().value);
  }
}

function rememberTarget(url, filename = '') {
  if (!isAllowedFastShareUrl(url)) return '';
  cleanupTargets();
  const token = crypto.randomBytes(18).toString('base64url');
  proxyTargets.set(token, {
    url: String(url),
    filename: playbackFilename(filename),
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  cleanupTargets();
  return token;
}

function getTarget(token) {
  cleanupTargets();
  const entry = proxyTargets.get(String(token || ''));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) proxyTargets.delete(String(token || ''));
    return null;
  }
  return entry;
}

function wrapStream(stream, req) {
  const directUrl = String(stream?.url || '');
  if (!isAllowedFastShareUrl(directUrl)) return stream;
  const base = publicBaseUrl(req);
  if (!base) return stream;
  const filename = playbackFilename(stream?.behaviorHints?.filename || stream?.title || 'video');
  const token = rememberTarget(directUrl, filename);
  if (!token) return stream;
  return {
    ...stream,
    url: `${base}/play/${token}/${encodeURIComponent(filename)}`,
    behaviorHints: {
      ...(stream.behaviorHints || {}),
      filename,
      notWebReady: false,
      webPlaybackContainer: fileExtension(filename) || undefined,
      webPlaybackPreferred: iosContainerPriority(filename) === 0
    }
  };
}

function copyHeader(upstream, res, name) {
  const value = upstream.headers.get(name);
  if (value) res.set(name, value);
}

async function proxyHandler(req, res) {
  const target = getTarget(req.params.token);
  if (!target) {
    res.status(404).json({ error: 'Playback link expired. Reload the stream list.' });
    return;
  }
  if (!isAllowedFastShareUrl(target.url)) {
    res.status(403).json({ error: 'Unsupported playback host.' });
    return;
  }

  const headers = {
    Accept: req.get('accept') || '*/*',
    'User-Agent': req.get('user-agent') || 'Mozilla/5.0 NuvioWeb FastShare Proxy'
  };
  for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }

  let upstream;
  try {
    upstream = await fetch(target.url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      compress: false,
      size: 0
    });
  } catch (error) {
    res.status(502).json({ error: 'FastShare playback connection failed.' });
    return;
  }

  res.status(upstream.status);
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified');
  res.set('Cache-Control', 'private, no-store');
  res.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
  copyHeader(upstream, res, 'content-range');
  copyHeader(upstream, res, 'content-length');
  copyHeader(upstream, res, 'etag');
  copyHeader(upstream, res, 'last-modified');
  const contentType = proxyMimeType(target.filename, upstream.headers.get('content-type'));
  if (contentType) res.set('Content-Type', contentType);
  res.set('Content-Disposition', `inline; filename="${target.filename.replace(/["\\]/g, '_')}"`);

  if (req.method === 'HEAD' || !upstream.body) {
    upstream.body?.destroy?.();
    res.end();
    return;
  }

  upstream.body.on('error', () => {
    if (!res.headersSent) res.status(502);
    if (!res.writableEnded) res.end();
  });
  res.on('close', () => {
    if (!res.writableEnded) upstream.body?.destroy?.();
  });
  upstream.body.pipe(res);
}

function installFastSharePlayProxy(runtime) {
  if (!runtime?.app || typeof runtime.buildStreamResponse !== 'function') return runtime;
  if (runtime.__fastSharePlayProxyInstalled) return runtime;
  runtime.__fastSharePlayProxyInstalled = true;

  const originalBuildStreamResponse = runtime.buildStreamResponse.bind(runtime);
  runtime.buildStreamResponse = async function buildProxiedStreamResponse(req, debug = false) {
    const result = await originalBuildStreamResponse(req, debug);
    if (!result || !Array.isArray(result.streams)) return result;
    let streams = result.streams.map(stream => wrapStream(stream, req));
    if (isAppleMobileRequest(req)) {
      streams = streams
        .map((stream, index) => ({ stream, index }))
        .sort((a, b) => {
          const left = iosContainerPriority(a.stream?.behaviorHints?.filename || '');
          const right = iosContainerPriority(b.stream?.behaviorHints?.filename || '');
          return left - right || a.index - b.index;
        })
        .map(entry => entry.stream);
    }
    return { ...result, streams };
  };

  // Keep the original token-only route for already cached clients and expose
  // the filename route so Safari/AirPlay can infer the container from the URL.
  runtime.app.get('/play/:token/:filename?', proxyHandler);
  runtime.app.head('/play/:token/:filename?', proxyHandler);
  return runtime;
}

module.exports = installFastSharePlayProxy;
module.exports.isAllowedFastShareUrl = isAllowedFastShareUrl;
module.exports.proxyMimeType = proxyMimeType;
module.exports.publicBaseUrl = publicBaseUrl;
module.exports.wrapStream = wrapStream;
module.exports.playbackFilename = playbackFilename;
module.exports.iosContainerPriority = iosContainerPriority;
module.exports.isAppleMobileRequest = isAppleMobileRequest;
