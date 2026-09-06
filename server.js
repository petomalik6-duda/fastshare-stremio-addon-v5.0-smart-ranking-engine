'use strict';

// Compatibility entrypoint for older Render services that still use
// `node server.js` as their Start Command. The production implementation lives
// in src/server.js; keeping this shim prevents old dashboard settings from
// silently running the obsolete v6.3.x ranking engine.
const runtime = require('./src/server');
const { PORT, VERSION } = require('./src/config');

if (require.main === module) {
  runtime.app.listen(PORT, () => {
    console.log(`FastShare Stremio addon v${VERSION} on ${PORT} (compat entrypoint)`);
  });
}

module.exports = runtime;
