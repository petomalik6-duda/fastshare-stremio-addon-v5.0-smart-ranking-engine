'use strict';

// Compatibility entrypoint for older Render services that still use
// `node server.js` as their Start Command. The launcher applies the final
// series-title safety guard before loading the modular production runtime.
const runtime = require('./src/launcher');
const { PORT, VERSION } = require('./src/config');

if (require.main === module) {
  runtime.app.listen(PORT, () => {
    console.log(`FastShare Stremio addon v${VERSION} on ${PORT} (compat entrypoint)`);
  });
}

module.exports = runtime;
