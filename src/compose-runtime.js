'use strict';

// Compatibility layers are ordered: each receives the runtime produced above.
module.exports = function composeRuntime() {
  // Install the FastShare playback proxy on the base stream runtime before
  // unified-server captures it. This keeps Webshare untouched while FastShare
  // streams become browser/iOS-friendly same-origin /play URLs.
  const baseStreamRuntime = require('./server');
  require('./fastshare-play-proxy')(baseStreamRuntime);
  
  const runtime = require('./unified-server');
  require('./configure-fix')(runtime);
  require('./runtime-fix-v72')(runtime);
  const compatibleRuntime = require('./manifest-compat')(runtime);
  const strictRuntime = require('./strict-audio-fix')(compatibleRuntime);
  const providerRuntime = require('./provider-stream-mode')(strictRuntime);
  const concertRuntime = require('./concert-direct-catalog')(providerRuntime);
  const enrichedConcertRuntime = require('./concert-metadata-overlay')(concertRuntime);
  const referenceConcertRuntime = require('./concert-reference-catalog')(enrichedConcertRuntime);
  const concertCompatRuntime = require('./concert-discovery-compat')(referenceConcertRuntime);
  const providerRecentRuntime = require('./provider-recent-catalog')(concertCompatRuntime);
  const superConcertRuntime = require('./concert-super-catalog')(providerRecentRuntime);
  const mergedCatalogRuntime = require('./provider-recent-merge')(superConcertRuntime);
  const qualityRuntime = require('./quality-engine')(mergedCatalogRuntime);
  const finalRuntime = require('./catalog-finalizer')(qualityRuntime);
  return finalRuntime;
};
