import { parse } from 'parse5';
import { z } from 'zod';
import { createFixedHostFetcher } from './fixed-fetch.mjs';
import { AppError, parseSource } from './validation.mjs';

export const examplePage =
  'https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/multiple-video-formats.html';

const inputSchema = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
const pagePath = /^\/[a-zA-Z0-9._~/-]{0,1023}$/;
const mediaPath = /\.(mp4|webm|m3u8|mpd)$/i;
const embeds = new Set(['youtube', 'rutube', 'vimeo', 'twitch']);
const limit = 12;

export function discoveryHosts(value = '') {
  const hosts = new Set(
    value
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    hosts.size > 16 ||
    [...hosts].some(
      (host) =>
        host.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          host,
        ) ||
        /\.(localhost|local|internal|test|invalid)$/.test(host),
    )
  ) {
    throw new Error('DISCOVERY_HOSTS must contain at most 16 exact public DNS hostnames');
  }
  return hosts;
}

function publicUrl(value, base) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search)
      return url;
  } catch {
    // Some HTML attributes are not URLs.
  }
  return null;
}

function nodes(root) {
  const stack = [root];
  return {
    *[Symbol.iterator]() {
      while (stack.length) {
        const node = stack.pop();
        yield node;
        for (let i = (node.childNodes?.length ?? 0) - 1; i >= 0; i--) {
          stack.push(node.childNodes[i]);
        }
      }
    },
  };
}

function* videoObjects(value) {
  const stack = [value];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (
      node['@type'] === 'VideoObject' ||
      (Array.isArray(node['@type']) && node['@type'].includes('VideoObject'))
    ) {
      yield node;
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else if (node['@graph']) {
      stack.push(node['@graph']);
    }
  }
}

export function discoverHtml(html, page) {
  const candidates = new Map();
  let title = '';
  let hasDash = false;
  const add = (value, kind) => {
    const url = publicUrl(value, page);
    if (!url) return;
    url.hash = '';
    const format = mediaPath.exec(url.pathname)?.[1].toLowerCase();

    if (format && url.origin === page.origin) {
      if (format === 'mpd') {
        hasDash = true;
      } else if (candidates.size < limit) {
        candidates.set(url.href, { url: url.href, format, provider: 'video' });
      }
      return;
    }

    if (candidates.size >= limit || !['embed', 'metadata'].includes(kind)) return;
    try {
      const media = parseSource({ url: url.href });
      // Reuse the existing providers with stable public IDs. No arbitrary frames or streams.
      if (embeds.has(media.type) && !media.url?.includes('?')) {
        const key = media.url ?? `${media.type}:${media.live}:${media.providerId}`;
        if (!candidates.has(key)) {
          candidates.set(key, {
            url: media.url ?? url.href,
            format: 'embed',
            provider: media.type,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  };

  for (const node of nodes(parse(html))) {
    const attr = (name) => node.attrs?.find((item) => item.name === name)?.value;
    if (node.tagName === 'title' && !title) title = node.childNodes?.[0]?.value?.trim() || '';
    if (node.tagName === 'video') add(attr('src'), 'media');
    if (node.tagName === 'source' && node.parentNode?.tagName === 'video')
      add(attr('src'), 'media');
    if (node.tagName === 'iframe' && attr('srcdoc') === undefined) add(attr('src'), 'embed');
    if (
      node.tagName === 'meta' &&
      [
        'og:video',
        'og:video:url',
        'og:video:secure_url',
        'twitter:player',
        'twitter:player:stream',
      ].includes(attr('property') ?? attr('name'))
    ) {
      add(attr('content'), 'metadata');
    }
    if (node.tagName === 'script' && attr('type') === 'application/ld+json') {
      const data = node.childNodes?.[0]?.value;
      if (!data || data.length > 65536) continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      for (const item of videoObjects(json)) {
        add(item.contentUrl, 'metadata');
        add(item.embedUrl, 'embed');
      }
    }
  }

  return { title: title.slice(0, 120), candidates: [...candidates.values()], hasDash };
}

export function createPageDiscovery(
  hosts,
  fetchPage = (hostname, pathname) =>
    createFixedHostFetcher({
      hostname,
      allowedPath: pagePath,
      label: 'Страница',
      dnsTimeoutMs: 2000,
      responseTimeoutMs: 4000,
      maxResponseBytes: 1024 * 1024,
      verifyContentType: /^text\/html(?:\s*;|$)/i,
    })(pathname),
) {
  let active = 0;
  return async (input) => {
    const { url } = inputSchema.parse(input);
    const page = publicUrl(url);
    if (!page || page.hash || !pagePath.test(page.pathname) || mediaPath.test(page.pathname)) {
      throw new AppError(400, 'Укажите HTTPS-страницу без параметров и фрагмента.');
    }
    if (page.href !== examplePage && !hosts.has(page.hostname)) {
      throw new AppError(
        422,
        'Этот сайт пока не подключён к поиску на странице. Вставьте прямую ссылку на видео или код поддерживаемого плеера.',
      );
    }
    if (active >= 3) throw new AppError(429, 'Поиск занят. Попробуйте чуть позже.');
    active++;
    try {
      return discoverHtml(await fetchPage(page.hostname, page.pathname), page);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        502,
        'Не удалось прочитать страницу. Проверьте адрес или добавьте прямую ссылку.',
      );
    } finally {
      active--;
    }
  };
}
