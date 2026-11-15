import { parse } from 'parse5';
import { AppError } from './validation.mjs';
import { safeArtwork } from '../../public/artwork.js';
import { createFixedHostFetcher } from './fixed-fetch.mjs';
export function lordfilmPath(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(400, 'Введите ссылку на страницу LordFilm.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== '8.lordfilms.mobile' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/[1-9]\d{0,9}\/$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new AppError(400, 'Поддерживаются страницы https://8.lordfilms.mobile/<номер>/');
  return url.pathname;
}
const readPage = createFixedHostFetcher({
  hostname: '8.lordfilms.mobile',
  allowedPath: /^\/[1-9]\d{0,9}\/$/,
  label: 'LordFilm',
});
export async function resolveLordfilm(input, read = readPage) {
  const path = lordfilmPath(input);
  const document = parse(await read(path));
  let title, config, poster;
  const text = (node) => node.value || (node.childNodes || []).map(text).join('');
  const walk = (node) => {
    const attr = (name) => node.attrs?.find((a) => a.name === name)?.value;
    if (node.tagName === 'meta' && attr('property') === 'og:image') {
      try {
        poster = safeArtwork(new URL(attr('content'), 'https://8.lordfilms.mobile').href);
      } catch {
        /* No trusted poster. */
      }
    }
    if (node.tagName === 'h1') title = text(node).trim().slice(0, 120);
    if (!title && node.tagName === 'title') title = text(node).trim().slice(0, 120);
    if (
      node.tagName === 'video-player' &&
      attr('data-aggregator') === 'kp' &&
      /^\d{1,10}$/.test(attr('data-title-id') || '') &&
      /^\d{1,10}$/.test(attr('data-publisher-id') || '')
    )
      config = { titleId: attr('data-title-id'), publisherId: attr('data-publisher-id') };
    for (const child of node.childNodes || []) walk(child);
  };
  walk(document);
  if (!config)
    throw new AppError(
      422,
      'На странице не найден поддерживаемый CVH-плеер. Можно вставить поддерживаемый iframe или прямую видеоссылку.',
    );
  return {
    ...(poster ? { poster } : {}),
    type: 'lordfilm',
    title: title || `LordFilm · ${path.split('/')[1]}`,
    sourcePage: `https://8.lordfilms.mobile${path}`,
    config,
    live: false,
  };
}
export function createLordfilmResolver(resolve = resolveLordfilm) {
  const cache = new Map();
  let active = 0;
  return async (url) => {
    const key = lordfilmPath(url),
      entry = cache.get(key);
    if (entry?.until > Date.now()) return entry.value;
    if (active >= 3)
      throw new AppError(429, 'Уже загружаются другие страницы LordFilm. Повторите позже.');
    active++;
    try {
      const value = await resolve(url);
      if (cache.size >= 20) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: Date.now() + 60000 });
      return value;
    } catch (error) {
      if (error.status) throw error;
      throw new AppError(
        502,
        'Не удалось загрузить LordFilm. Повторите позже или используйте код поддерживаемого плеера.',
      );
    } finally {
      active--;
    }
  };
}
