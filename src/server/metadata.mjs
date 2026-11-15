import { createFixedHostFetcher } from './fixed-fetch.mjs';
import { safeArtwork } from '../../public/artwork.js';
const fixed = (hostname, allowedPath) =>
  createFixedHostFetcher({
    hostname,
    allowedPath,
    label: hostname,
    dnsTimeoutMs: 1500,
    responseTimeoutMs: 2500,
    maxResponseBytes: 512 * 1024,
  });
const readers = {
  rutube: fixed('rutube.ru', /^\/api\/video\/[a-f0-9]{32}\/\?format=json$/),
  youtube: fixed(
    'www.youtube.com',
    /^\/oembed\?url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3D[A-Za-z0-9_-]{11}&format=json$/,
  ),
  vimeo: fixed(
    'vimeo.com',
    /^\/api\/oembed\.json\?url=https%3A%2F%2Fplayer\.vimeo\.com%2Fvideo%2F\d{1,15}(?:%3Fh%3D[a-f0-9]{6,32})?$/,
  ),
};
export function createMetadataResolver(
  read = async (type, path) => JSON.parse(await readers[type](path)),
) {
  const cache = new Map();
  let active = 0;
  return async (media, { preserveTitle = false } = {}) => {
    if (!['rutube', 'youtube', 'vimeo'].includes(media.type)) return media;
    const key = `${media.type}:${media.url || media.providerId}`;
    let info = cache.get(key);
    if (!info || info.until < Date.now()) {
      if (active >= 3) return media;
      active++;
      try {
        const path =
          media.type === 'rutube'
            ? `/api/video/${media.providerId}/?format=json`
            : media.type === 'youtube'
              ? `/oembed?${new URLSearchParams({ url: `https://www.youtube.com/watch?v=${media.providerId}`, format: 'json' })}`
              : `/api/oembed.json?${new URLSearchParams({ url: media.url })}`;
        const result = await read(media.type, path);
        const title = typeof result.title === 'string' ? result.title.trim().slice(0, 120) : null;
        const poster = safeArtwork(result.thumbnail_url);
        info = { title, poster, until: Date.now() + 300000 };
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, info);
      } catch {
        return media;
      } finally {
        active--;
      }
    }
    return {
      ...media,
      ...(!preserveTitle && info.title ? { title: info.title } : {}),
      ...(info.poster ? { poster: info.poster } : {}),
    };
  };
}
