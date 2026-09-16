'use strict';

const { parseSeriesRelease } = require('./ranking');

// A series' last_air_date alone does not prove that episode is available.
function availableEpisodeDate(meta, filename, now = Date.now()) {
  const parsed = parseSeriesRelease(String(filename || '').replace(/[._]+/g, ' '));
  const videos = meta?.videos || meta?.raw?.videos || [];
  let latest = '';
  for (const video of videos) {
    const season = Number(video.season), episode = Number(video.episode);
    const matches = parsed.episodes.some(row => row.season === season && row.episodes.includes(episode)) || parsed.seasonPacks.includes(season);
    if (!matches) continue;
    const value = String(video.released || video.airDate || video.firstAired || '').slice(0, 10);
    const timestamp = Date.parse(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(timestamp) && timestamp <= now && new Date(timestamp).toISOString().slice(0, 10) === value && value > latest) latest = value;
  }
  return latest;
}

module.exports = { availableEpisodeDate };
