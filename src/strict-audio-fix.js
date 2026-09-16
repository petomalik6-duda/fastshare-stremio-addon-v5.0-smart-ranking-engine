'use strict';

function installStrictAudioFix(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  function normalizeText(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ');
  }

  function explicitDubFromText(text) {
    const normalized = normalizeText(text);
    // Strong evidence intentionally excludes a bare "CZ audio" / "SK audio" label.
    // Those labels are useful hints but are not proof that the media track is dubbed.
    const cz = /\b(cz|cze|cs|ceske|cesky|czech)\s*(dab|dub|dabing|dubbing)\b|\b(czdab|czdub)\b/.test(normalized);
    const sk = /\b(sk|svk|slovak|slovensky)\s*(dab|dub|dabing|dubbing)\b|\b(skdab|skdub)\b/.test(normalized);
    return { cz, sk, any: cz || sk, evidence: cz || sk ? 'explicit-dub' : 'none' };
  }

  function trackDubEvidence(value) {
    const raw = value?.raw || value || {};
    const tracks = [
      raw.audioTracks, raw.audio_tracks, raw.audio, raw.languages, raw.language,
      raw.mediaInfo?.audio, raw.mediainfo?.audio, raw.metadata?.audio
    ].flat(Infinity).filter(Boolean);
    const text = tracks.map(track => typeof track === 'string' ? track : JSON.stringify(track)).join(' ');
    const normalized = normalizeText(text);
    const cz = /\b(cz|cze|ces|czech|cesky|ceske)\b/.test(normalized);
    const sk = /\b(sk|svk|slk|slovak|slovensky)\b/.test(normalized);
    return { cz, sk, any: cz || sk, evidence: cz || sk ? 'track-metadata' : 'none' };
  }

  function dubbingEvidence(value) {
    const track = trackDubEvidence(value);
    if (track.any) return track;
    const text = typeof value === 'string'
      ? value
      : `${value?.name || ''} ${value?.title || ''} ${value?.behaviorHints?.filename || ''}`;
    return explicitDubFromText(text);
  }

  function sanitizeStream(stream) {
    const evidence = dubbingEvidence(stream);
    if (evidence.any) return {
      ...stream,
      behaviorHints: { ...(stream.behaviorHints || {}), dubbingEvidence: evidence.evidence }
    };

    const provider = /^webshare/i.test(String(stream?.name || '')) ? 'Webshare'
      : /^fastshare/i.test(String(stream?.name || '')) ? 'FastShare'
      : String(stream?.name || 'FastShare + Webshare').replace(/\s+(CZ|SK|CZ\/SK).*$/i, '');
    const title = String(stream?.title || '')
      .replace(/CZ\/SK Dabing/gi, 'Audio neoverené')
      .replace(/CZ Dabing/gi, 'Audio neoverené')
      .replace(/SK Dabing/gi, 'Audio neoverené')
      .replace(/CZ\/EN Audio/gi, 'Audio neoverené')
      .replace(/SK\/EN Audio/gi, 'Audio neoverené')
      .replace(/CZ Audio/gi, 'Audio neoverené')
      .replace(/SK Audio/gi, 'Audio neoverené');

    return {
      ...stream,
      name: provider,
      title,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        dubbingEvidence: 'none',
        bingeGroup: String(stream?.behaviorHints?.bingeGroup || 'fastshare-webshare-unified').replace(/-(CZ-SK|CZ-EN|SK-EN|CZ|SK)$/i, '-any')
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

  return { ...runtime, sanitizeStream, explicitDubFromText, trackDubEvidence, dubbingEvidence };
}

module.exports = installStrictAudioFix;
