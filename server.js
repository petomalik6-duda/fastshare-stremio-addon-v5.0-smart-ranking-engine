'use strict';

// Compatibility entrypoint for older Render services that still use
// `node server.js` as their Start Command. Always go through src/entrypoint.js
// so the same final series-title safety guard is used as with `npm start`.
const runtime = require('./src/entrypoint');

if (require.main === module) runtime.start();

module.exports = runtime;
