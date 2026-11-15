import { z } from 'zod';
import { parse } from 'parse5';
import { AppError, parseSource } from './validation.mjs';
import { createFixedHostFetcher } from './fixed-fetch.mjs';
import { yummyPath } from './yummy.mjs';
import { lordfilmPath } from './lordfilm.mjs';
import { safeArtwork } from '../../public/artwork.js';
const schema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .refine((value) =>
        [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
      ),
    providers: z
      .array(z.enum(['rutube', 'yummy', 'lordfilm']))
      .min(1)
      .max(3)
      .default(['rutube', 'yummy', 'lordfilm']),
  })
  .strict();
const fixed = (hostname, allowedPath) =>
  createFixedHostFetcher({
    hostname,
    allowedPath,
    label: hostname,
    dnsTimeoutMs: 2000,
    responseTimeoutMs: 4000,
    maxResponseBytes: 1024 * 1024,
  });
const readers = {
  rutube: fixed('rutube.ru', /^\/api\/search\/video\/\?query=[A-Za-z0-9%*_.+-]{1,1800}&page=1$/),
  yummy: fixed('old.yummyani.me', /^\/api\/search\?q=[A-Za-z0-9%*_.+-]{1,1800}&limit=8&offset=0$/),
  lordfilm: fixed(
    '8.lordfilms.mobile',
    /^\/\?do=search&subaction=search&story=[A-Za-z0-9%*_.+-]{1,1800}$/,
  ),
};
const title = (value) => (typeof value === 'string' ? value.trim().slice(0, 120) : '');
export function parseSearchResults(provider, raw) {
  const results = [],
    seen = new Set();
  const add = (url, name, poster, year) => {
    if (!name || seen.has(url) || results.length >= 8) return;
    seen.add(url);
    results.push({
      provider,
      url,
      title: name,
      ...(safeArtwork(poster) ? { poster: safeArtwork(poster) } : {}),
      ...(year ? { detail: String(year).slice(0, 30) } : {}),
    });
  };
  if (provider === 'rutube') {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.results)) throw new Error('Invalid search response');
    for (const item of data.results.slice(0, 50)) {
      if (item?.is_livestream || !/^[a-f0-9]{32}$/.test(item?.id || '')) continue;
      const url = `https://rutube.ru/video/${item.id}/`;
      parseSource({ url });
      add(url, title(item.title), item.thumbnail_url);
    }
  } else if (provider === 'yummy') {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.response)) throw new Error('Invalid search response');
    for (const item of data.response.slice(0, 30)) {
      if (!/^[a-z0-9-]{1,180}$/.test(item?.anime_url || '')) continue;
      const url = `https://old.yummyani.me/catalog/item/${item.anime_url}`;
      yummyPath(url);
      const poster = item.poster?.small?.startsWith('//')
        ? `https:${item.poster.small}`
        : item.poster?.small;
      add(url, title(item.title), poster, item.year);
    }
  } else if (provider === 'lordfilm') {
    const document = parse(raw),
      text = (node) =>
        node.value ||
        (node.childNodes || [])
          .filter((n) => !['script', 'style'].includes(n.tagName))
          .map(text)
          .join('');
    const walk = (node) => {
      if (results.length >= 8) return;
      const attr = (name) => node.attrs?.find((a) => a.name === name)?.value;
      if (node.tagName === 'a' && (attr('class') || '').split(/\s+/).includes('item__title')) {
        try {
          const url = new URL(attr('href'), 'https://8.lordfilms.mobile').href;
          lordfilmPath(url);
          add(url, title(text(node)));
        } catch {
          /* Skip non-catalog anchors. */
        }
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(document);
  }
  return results;
}
export function createSearchService(read = (provider, path) => readers[provider](path)) {
  const cache = new Map();
  let active = 0;
  return async (input) => {
    const { query, providers } = schema.parse(input);
    const selected = [...new Set(providers)];
    const key = selected.join(',') + ':' + query.toLowerCase();
    const cached = cache.get(key);
    if (cached?.until > Date.now()) return cached.value;
    if (active >= 2)
      throw new AppError(429, 'Уже выполняются другие поисковые запросы. Повторите позже.');
    active++;
    try {
      const found = await Promise.all(
        selected.map(async (provider) => {
          const path =
            provider === 'rutube'
              ? `/api/search/video/?${new URLSearchParams({ query, page: '1' })}`
              : provider === 'yummy'
                ? `/api/search?${new URLSearchParams({ q: query, limit: '8', offset: '0' })}`
                : `/?${new URLSearchParams({ do: 'search', subaction: 'search', story: query })}`;
          try {
            return {
              provider,
              results: parseSearchResults(provider, await read(provider, path)),
              available: true,
            };
          } catch {
            return {
              provider,
              results: [],
              available: false,
              reason:
                'Источник не ответил или изменил формат поиска. Попробуйте поиск на его сайте.',
            };
          }
        }),
      );
      const value = {
        query,
        results: found.flatMap((p) => p.results),
        sources: found.map(({ results: _results, ...rest }) => rest),
      };
      if (cache.size >= 30) cache.delete(cache.keys().next().value);
      if (found.some((p) => p.available)) cache.set(key, { value, until: Date.now() + 60000 });
      return value;
    } finally {
      active--;
    }
  };
}
