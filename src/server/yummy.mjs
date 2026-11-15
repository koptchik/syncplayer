import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import { AppError, parseSource } from './validation.mjs';
import { createFixedHostFetcher } from './fixed-fetch.mjs';
export { isPublicIPv4 } from './fixed-fetch.mjs';

const hostname = 'old.yummyani.me';
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
export function createYummyFetcher(dependencies = {}) {
  return createFixedHostFetcher({
    ...dependencies,
    hostname,
    allowedPath: /^\/(?:catalog\/item\/[a-z0-9-]{1,180}\/?|api\/anime\/\d{1,10}\/videos)$/,
    label: 'YummyAnime',
  });
}
const readPage = createYummyFetcher();
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
export function createYummyResolver(resolve = resolveYummy) {
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
      const value = await resolve(url);
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
