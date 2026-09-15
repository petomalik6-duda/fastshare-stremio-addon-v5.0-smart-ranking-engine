'use strict';

const { fetchJson, normalize } = require('./utils');
const { VERSION } = require('./config');

const cache = new Map();
const TTL = 24 * 60 * 60 * 1000;

function titleSimilarity(a, b) {
  const aa = normalize(a);
  const bb = normalize(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 100;
  if (aa.includes(bb) || bb.includes(aa)) return 85;
  const at = new Set(aa.split(' ').filter(x => x.length > 2));
  const bt = new Set(bb.split(' ').filter(x => x.length > 2));
  if (!at.size || !bt.size) return 0;
  const overlap = [...at].filter(x => bt.has(x)).length;
  return Math.round(100 * overlap / Math.max(at.size, bt.size));
}

function cleanQuery(title) {
  return String(title || '')
    .replace(/\b(2160p|1080p|720p|4k|uhd|hdr|web[- ]?dl|webrip|bluray|remux)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchWikipedia(lang, query) {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', '5');
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  const data = await fetchJson(url.toString(), {
    headers: { 'User-Agent': `FastShare-Webshare/${VERSION}` }
  });
  return Array.isArray(data?.query?.search) ? data.query.search : [];
}

async function pageSummary(lang, title) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  return fetchJson(url, {
    headers: { 'User-Agent': `FastShare-Webshare/${VERSION}`, Accept: 'application/json' }
  });
}

async function wikipediaMetadata(title) {
  const key = normalize(title);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.value;

  const query = cleanQuery(title);
  const year = String(title || '').match(/\b(19\d{2}|20\d{2})\b/)?.[0] || '';
  const variants = [query, year ? `${query} ${year}` : query, `${query} concert`];

  for (const lang of ['cs', 'en']) {
    for (const q of variants) {
      try {
        const rows = await searchWikipedia(lang, q);
        const ranked = rows.map(row => {
          let score = titleSimilarity(query, row.title || '');
          if (/\b(concert|tour|live|unplugged|festival|koncert|turne|turné)\b/i.test(row.title || '')) score += 12;
          if (year && String(row.title || '').includes(year)) score += 10;
          return { row, score };
        }).sort((a, b) => b.score - a.score);

        const best = ranked[0];
        if (!best || best.score < 50) continue;
        const summary = await pageSummary(lang, best.row.title);
        const extract = String(summary?.extract || '').trim();
        if (!extract) continue;

        const value = {
          source: `wikipedia-${lang}`,
          name: summary?.title || best.row.title,
          description: extract,
          poster: summary?.thumbnail?.source || summary?.originalimage?.source || undefined,
          background: summary?.originalimage?.source || summary?.thumbnail?.source || undefined,
          links: summary?.content_urls?.desktop?.page ? [{ name: 'Wikipedia', category: 'information', url: summary.content_urls.desktop.page }] : undefined
        };
        cache.set(key, { at: Date.now(), value });
        return value;
      } catch {
        // Try next query/language.
      }
    }
  }

  cache.set(key, { at: Date.now(), value: null });
  return null;
}

module.exports = { wikipediaMetadata, titleSimilarity };
