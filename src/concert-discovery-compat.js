'use strict';

function install(runtime) {
  if (!runtime || typeof runtime.discoverConcerts !== 'function') return runtime;
  const original = runtime.discoverConcerts;
  return {
    ...runtime,
    discoverConcerts: req => original(runtime, req)
  };
}

module.exports = install;
