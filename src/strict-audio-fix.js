'use strict';

function installStrictAudioFix(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  function explicitDubFromText(text) {
    const raw = String(text || '').toLowerCase();
    const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ');
    const cz = /\b(cz|cze|cs|ceske|cesky|czech)\s*(dab|dub|dabing|dubbing|audio)\b|\b(czdab|czdub)\b/.test(normalized);
    const sk = /\b(sk|svk|slovak|slovensky)\s*(dab|dub|dabing|dubbing|audio)\b|\b(skdab|skdub)\b/.test(normalized);
    return { cz, sk, any: cz || sk };
  }

  function sanitizeStream(stream) {
    if (!stream || !String(stream.name || '').toLowerCase().startsWith('webshare')) return stream;
    const evidence = explicitDubFromText(`${stream.title || ''} ${stream.behaviorHints?.filename || ''}`);
    if (evidence.any) return stream;

    const cleanName = 'Webshare';
    let title = String(stream.title || '')
      .replace(/CZ\/SK Dabing/gi, 'Audio neoverené')
      .replace(/CZ Dabing/gi, 'Audio neoverené')
      .replace(/SK Dabing/gi, 'Audio neoverené')
      .replace(/CZ\/EN Audio/gi, 'Audio neoverené')
      .replace(/SK\/EN Audio/gi, 'Audio neoverené')
      .replace(/CZ Audio/gi, 'Audio neoverené')
      .replace(/SK Audio/gi, 'Audio neoverené');

    return {
      ...stream,
      name: cleanName,
      title,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        bingeGroup: String(stream.behaviorHints?.bingeGroup || 'webshare-auto').replace(/-(CZ-SK|CZ-EN|SK-EN|CZ|SK)$/i, '-any')
      }
    };
  }

  function remove(paths) {
    const wanted = new Set(paths);
    app._router.stack = app._router.stack.filter(layer => !layer.route || !wanted.has(layer.route.path));
  }

  remove(['/stream/:type/:id.json', '/:config/stream/:type/:id.json']);

  async function send(req, res) {
    if (req.params.config) res.set('Cache-Control', 'private, no-store');
    try {
      const result = await runtime.buildUnifiedResponse(req, false);
      const streams = (result?.streams || []).map(sanitizeStream);
      res.json({ streams });
    } catch (error) {
      console.error('[strict-stream-error]', String(error?.message || error));
      res.json({ streams: [] });
    }
  }

  app.get('/stream/:type/:id.json', send);
  app.get('/:config/stream/:type/:id.json', send);

  return { ...runtime, sanitizeStream, explicitDubFromText };
}

module.exports = installStrictAudioFix;
