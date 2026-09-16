'use strict';

// User-reported discovery gaps. These are search candidates, never unconditional
// catalog entries: normal title/year, provider availability, audio and 4K checks
// still apply. They do not receive any special ranking priority.
const REQUESTED_MOVIES = ['tt20424814', 'tt27165187'];

async function requestedCandidates(type, getMeta) {
  if (type !== 'movie') return [];
  const rows = await Promise.all(REQUESTED_MOVIES.map(async id => {
    try {
      const meta = await getMeta(type, id);
      const raw = meta?.raw || {};
      if (!meta?.title || meta.title === id) return null;
      return {
        ...raw,
        id,
        type,
        _requestedCatalog: true,
        name: meta.title,
        releaseInfo: raw.releaseInfo || meta.year,
        _releaseDate: raw.released || undefined
      };
    } catch { return null; }
  }));
  return rows.filter(Boolean);
}

module.exports = { requestedCandidates };
