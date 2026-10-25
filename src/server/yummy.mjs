import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import { AppError, parseSource } from './validation.mjs';

const hostname = 'old.yummyani.me';
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked.addSubnet(address, prefix);
export const isPublicIPv4 = (address) => isIPv4(address) && !blocked.check(address);
export function yummyPath(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(400, 'Введите ссылку на страницу YummyAnime.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== hostname ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/catalog\/item\/[a-z0-9-]{1,180}\/?$/.test(url.pathname)
  )
    throw new AppError(400, 'Поддерживаются страницы https://old.yummyani.me/catalog/item/…');
  return url.pathname;
}
async function readPage(pathname) {
  let timer;
  const addresses = await Promise.race([
    lookup(hostname, { family: 4, all: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError(504, 'YummyAnime не ответил.')), 8000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicIPv4(address)))
    throw new AppError(502, 'Недопустимый сетевой адрес источника.');
  // Fixed hostname, pinned public IPv4, no redirects, cookies or user headers.
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        path: pathname,
        family: 4,
        method: 'GET',
        lookup: (_host, options, callback) =>
          options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
        headers: { Accept: 'text/html, application/json', 'User-Agent': 'Syncplayer/0.1' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy(
            new AppError(
              502,
              `YummyAnime ответил ${res.statusCode}; повторите позже или вставьте код плеера.`,
            ),
          );
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy(new AppError(502, 'Ответ источника слишком большой.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new AppError(504, 'YummyAnime не ответил вовремя.')),
      12000,
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(timeout));
    req.end();
  });
}
export async function resolveYummy(input, read = readPage) {
  const pathname = yummyPath(input);
  const document = parse(await read(pathname));
  let id, title, poster;
  const text = (node) => node.value || (node.childNodes || []).map(text).join('');
  const walk = (node) => {
    if (node.tagName === 'meta' && node.attrs.some((a) => a.name === 'id' && a.value === 'page_id'))
      id = node.attrs.find((a) => a.name === 'content')?.value;
    if (
      node.tagName === 'meta' &&
      node.attrs.some((a) => a.name === 'property' && a.value === 'og:image')
    ) {
      try {
        const url = new URL(
          node.attrs.find((a) => a.name === 'content')?.value,
          'https://old.yummyani.me',
        );
        if (
          url.protocol === 'https:' &&
          url.hostname === 'static.yani.tv' &&
          !url.port &&
          !url.username &&
          !url.password &&
          /^\/posters\/[a-z0-9/_.-]+$/i.test(url.pathname)
        )
          poster = url.href;
      } catch {
        /* Missing or untrusted artwork uses the title card. */
      }
    }
    if (node.tagName === 'h1') title = text(node).trim().slice(0, 120);
    for (const child of node.childNodes || []) walk(child);
  };
  walk(document);
  if (!/^\d{1,10}$/.test(id || ''))
    throw new AppError(
      502,
      'На странице не найден каталог видео. Можно вставить код плеера вручную.',
    );
  let data;
  try {
    data = JSON.parse(await read(`/api/anime/${id}/videos`));
  } catch (error) {
    if (error.status) throw error;
    throw new AppError(502, 'Источник вернул некорректный список видео.');
  }
  if (!Array.isArray(data.response)) throw new AppError(502, 'Источник не вернул список видео.');
  const options = data.response.slice(0, 2000).map((item) => {
    const variantId = createHash('sha256')
      .update(String(item.iframe_url) + '\n' + String(item.video_id || ''))
      .digest('hex')
      .slice(0, 24);
    const player = String(item.data?.player || 'Неизвестный плеер').slice(0, 80);
    const dubbing = String(item.data?.dubbing || 'Без названия').slice(0, 100);
    const episode = String(item.number || '?').slice(0, 30);
    const label = `${title || 'YummyAnime'} · ${dubbing} · серия ${episode}`.slice(0, 120);
    try {
      const media = parseSource({ url: item.iframe_url, title: label });
      return {
        id: variantId,
        player,
        dubbing,
        episode,
        title: label,
        supported: true,
        manual: Boolean(media.manual),
        url: media.url || item.iframe_url,
      };
    } catch {
      return { id: variantId, player, dubbing, episode, supported: false };
    }
  });
  return { title: title || 'YummyAnime', poster, options };
}
export function catalogMedia(catalogUrl, result, choice) {
  return {
    ...parseSource({ url: choice.url, title: choice.title }),
    catalogUrl: `https://old.yummyani.me${yummyPath(catalogUrl)}`,
    catalogTitle: result.title,
    poster: result.poster,
    variantId: choice.id,
    playerLabel: choice.player,
    dubbing: choice.dubbing,
    episode: choice.episode,
  };
}
export function createYummyResolver() {
  const cache = new Map();
  let active = 0;
  return async (url) => {
    const key = yummyPath(url);
    const cached = cache.get(key);
    if (cached?.until > Date.now()) return cached.value;
    if (active >= 3)
      throw new AppError(429, 'Уже загружаются другие страницы. Повторите через несколько секунд.');
    active++;
    try {
      const value = await resolveYummy(url);
      if (cache.size >= 20) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: Date.now() + 60000 });
      return value;
    } catch (error) {
      if (error.status) throw error;
      throw new AppError(502, 'Не удалось получить страницу YummyAnime. Попробуйте код плеера.');
    } finally {
      active--;
    }
  };
}
