'use strict';

const { login: fastshareLogin } = require('./fastshare');
const { login: webshareLogin } = require('./webshare');

function installConfigurator(runtime) {
  const app = runtime.app;
  if (!app?._router?.stack) return runtime;

  app._router.stack = app._router.stack.filter(layer => {
    if (!layer.route) return true;
    return layer.route.path !== '/configure';
  });

  function publicBaseUrl(req) {
    const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const protocol = forwarded || req.protocol || 'https';
    const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    return host ? `${protocol}://${host}` : '';
  }

  function encodeConfig(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  function esc(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function page(body) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FastShare + Webshare konfigurátor</title><style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#111;color:#eee}input,button{font-size:16px;padding:12px;border-radius:8px;border:1px solid #444;background:#222;color:#fff;width:100%;box-sizing:border-box;margin:8px 0}button{background:#1976d2;cursor:pointer}.box{background:#1b1b1b;padding:18px;border-radius:12px;margin:12px 0}.warn{color:#ffd166}.ok{color:#8ee59b}.bad{color:#ff8f8f}textarea{width:100%;min-height:96px;background:#0b0b0b;color:#9cdcfe;border:1px solid #444;border-radius:8px;padding:10px;box-sizing:border-box}a{color:#8ab4ff;display:inline-block;margin:8px 0}</style></head><body>${body}</body></html>`;
  }

  app.get('/configure', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(page(`
      <h1>FastShare + Webshare</h1>
      <div class="box">
        <p>Vyplň prihlásenie pre jednu alebo obe služby. Pred vytvorením manifestu server prihlásenie otestuje.</p>
        <form method="post" action="/configure">
          <h2>FastShare</h2>
          <input name="username" placeholder="FastShare username" autocomplete="username">
          <input name="password" type="password" placeholder="FastShare password" autocomplete="current-password">
          <h2>Webshare</h2>
          <input name="webshareUsername" placeholder="Webshare username alebo e-mail" autocomplete="username">
          <input name="websharePassword" type="password" placeholder="Webshare password" autocomplete="current-password">
          <button type="submit">Otestovať účty a vygenerovať manifest</button>
        </form>
        <p class="warn">Vygenerovanú URL nezdieľaj verejne. Obsahuje zakódované prihlasovacie údaje.</p>
      </div>`));
  });

  app.post('/configure', async (req, res) => {
    const fastCreds = {
      username: String(req.body.username || '').trim(),
      password: String(req.body.password || '')
    };
    const webCreds = {
      username: String(req.body.webshareUsername || '').trim(),
      password: String(req.body.websharePassword || '')
    };
    const fastConfigured = Boolean(fastCreds.username && fastCreds.password);
    const webConfigured = Boolean(webCreds.username && webCreds.password);

    if (!fastConfigured && !webConfigured) {
      res.status(400).type('html').send(page(`
        <h1>Chýbajú prihlasovacie údaje</h1>
        <div class="box"><p class="warn">Vyplň kompletné prihlásenie aspoň pre FastShare alebo Webshare.</p><a href="/configure">Späť na konfigurátor</a></div>`));
      return;
    }

    const [fastAuth, webAuth] = await Promise.all([
      fastConfigured ? fastshareLogin(fastCreds) : Promise.resolve({ ok: false, error: 'nezadané' }),
      webConfigured ? webshareLogin(webCreds) : Promise.resolve({ ok: false, error: 'nezadané' })
    ]);

    if (!fastAuth.ok && !webAuth.ok) {
      res.status(401).type('html').send(page(`
        <h1>Prihlásenie zlyhalo</h1>
        <div class="box">
          <p class="bad"><b>FastShare:</b> ${esc(fastAuth.error || 'prihlásenie zlyhalo')}</p>
          <p class="bad"><b>Webshare:</b> ${esc(webAuth.error || 'prihlásenie zlyhalo')}</p>
          <p>Manifest som nevytvoril, pretože by vracal prázdne streamy a katalógy.</p>
          <a href="/configure">Opraviť prihlásenie</a>
        </div>`));
      return;
    }

    const token = encodeConfig({
      username: fastAuth.ok ? fastCreds.username : '',
      password: fastAuth.ok ? fastCreds.password : '',
      webshareUsername: webAuth.ok ? webCreds.username : '',
      websharePassword: webAuth.ok ? webCreds.password : ''
    });
    const manifestUrl = `${publicBaseUrl(req)}/${token}/manifest.json`;
    const stremioUrl = `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`;
    const fastStatus = fastConfigured
      ? (fastAuth.ok ? '<span class="ok">OK</span>' : `<span class="bad">NEFUNGUJE – ${esc(fastAuth.error || '')}</span>`)
      : '<span class="warn">nezadané</span>';
    const webStatus = webConfigured
      ? (webAuth.ok ? '<span class="ok">OK</span>' : `<span class="bad">NEFUNGUJE – ${esc(webAuth.error || '')}</span>`)
      : '<span class="warn">nezadané</span>';

    res.set('Cache-Control', 'private, no-store');
    res.type('html').send(page(`
      <h1>Manifest je pripravený</h1>
      <div class="box">
        <p><b>FastShare:</b> ${fastStatus}</p>
        <p><b>Webshare:</b> ${webStatus}</p>
        <p class="ok"><b>Manifest obsahuje iba providery, ktorým prihlásenie prešlo.</b></p>
        <textarea readonly onclick="this.select()">${esc(manifestUrl)}</textarea>
        <a href="${esc(stremioUrl)}">Nainštalovať do Stremia</a><br>
        <a href="${esc(manifestUrl)}" target="_blank">Otvoriť manifest JSON</a><br>
        <a href="/configure">Vygenerovať iný manifest</a>
      </div>`));
  });

  return runtime;
}

module.exports = installConfigurator;
