import { z } from 'zod';
import { parseFragment } from 'parse5';

const name = z.string().trim().min(1).max(40);
export const createSchema = z
  .object({
    name,
    title: z.string().trim().min(1).max(80),
    permanent: z.boolean().optional().default(false),
  })
  .strict();
export const joinSchema = z.object({ name }).strict();
export const chatSchema = z.object({ text: z.string().trim().min(1).max(1000) }).strict();
export const controlSchema = z
  .object({
    mediaId: z.string().regex(/^[a-f0-9]{32}$/),
    sourceVersion: z.number().int().nonnegative().optional().default(0),
    position: z.number().finite().min(0).max(864000),
    playing: z.boolean(),
    checkpoint: z.boolean().optional().default(false),
    revision: z.number().int().nonnegative().optional(),
    rate: z.number().refine((n) => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(n)),
  })
  .strict();
export const sourceSchema = z
  .object({ url: z.string().max(8192), title: z.string().trim().max(120).optional() })
  .strict();
export const idSchema = z.string().regex(/^[a-f0-9]{32}$/);

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseSource(input) {
  const { url: inputUrl, title } = sourceSchema.parse(input);
  let url = inputUrl.trim();
  if (url.startsWith('<')) {
    const fragment = parseFragment(url);
    const frames = [];
    const walk = (node) => {
      if (node.tagName === 'iframe') frames.push(node);
      for (const child of node.childNodes || []) walk(child);
    };
    walk(fragment);
    if (frames.length !== 1 || frames[0].attrs.some((a) => a.name === 'srcdoc'))
      throw new AppError(400, 'Вставьте код одного iframe с адресом src, без srcdoc.');
    url = frames[0].attrs.find((a) => a.name === 'src')?.value?.trim() || '';
  }
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.length > 2048) throw new AppError(400, 'Адрес плеера слишком длинный.');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new AppError(400, 'Введите корректную ссылку.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) {
    throw new AppError(400, 'Нужна обычная ссылка без пароля и нестандартного порта.');
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'ru.yummyani.me' && u.protocol === 'https:' && u.pathname === '/iframeCVH.html') {
    const anime = u.searchParams.get('anime_id'),
      episode = u.searchParams.get('episode'),
      dubbing = u.searchParams.get('dubbing_code');
    if (
      !/^\d{1,10}$/.test(anime || '') ||
      !/^[1-9]\d{0,4}$/.test(episode || '') ||
      !/^[\p{L}\p{N} _.-]{1,100}$/u.test(dubbing || '')
    )
      throw new AppError(400, 'В ссылке CVH нужны аниме, озвучка и серия.');
    const params = new URLSearchParams({ anime_id: anime, episode, dubbing_code: dubbing });
    return {
      type: 'cvh',
      url: `https://ru.yummyani.me/iframeCVH.html?${params}`,
      title: title || `CVH · серия ${episode}`,
      live: false,
    };
  }
  if (host === 'alloha.yani.tv' && u.protocol === 'https:' && u.pathname === '/') {
    const params = new URLSearchParams();
    for (const name of ['token_movie', 'token', 'translation', 'season', 'episode']) {
      const value = u.searchParams.get(name);
      if (!(name.startsWith('token') ? /^[a-f0-9]{20,64}$/ : /^\d{1,10}$/).test(value || ''))
        throw new AppError(400, 'Неполная ссылка плеера Alloha.');
      params.set(name, value);
    }
    params.set('hidden', 'translation,season,episode');
    return {
      type: 'alloha',
      url: `https://alloha.yani.tv/?${params}`,
      title: title || 'Alloha',
      live: false,
      manual: true,
    };
  }
  if (host === 'kodikplayer.com') {
    if (
      u.protocol !== 'https:' ||
      !/^\/(seria|video|season)\/\d{1,15}\/[a-f0-9]{32}\/(?:360|480|720|1080)p\/?$/.test(u.pathname)
    )
      throw new AppError(
        400,
        'Для Kodik нужен HTTPS-код конкретной серии или фильма (seria/video). Выберите серию и озвучку на сайте и скопируйте код плеера.',
      );
    const episode = u.searchParams.get('episode');
    if (u.pathname.startsWith('/season/') && !/^[1-9]\d{0,4}$/.test(episode || ''))
      throw new AppError(400, 'Для сезона Kodik выберите конкретную серию.');
    const suffix = u.pathname.startsWith('/season/')
      ? `?translations=false&only_episode=true&only_season=true&episode=${episode}`
      : '';
    return {
      type: 'kodik',
      url: `https://kodikplayer.com${u.pathname}${suffix}`,
      title: title || `Kodik · ${u.pathname.split('/')[2]}`,
      live: false,
    };
  }
  let providerId;
  if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'youtu.be',
      'www.youtube-nocookie.com',
      'youtube-nocookie.com',
    ].includes(host)
  ) {
    providerId =
      host === 'youtu.be'
        ? u.pathname.slice(1)
        : u.pathname === '/watch'
          ? u.searchParams.get('v')
          : u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)\/?$/)?.[1];
    if (!/^[a-zA-Z0-9_-]{11}$/.test(providerId || ''))
      throw new AppError(400, 'Не удалось найти ID видео YouTube.');
    return { type: 'youtube', providerId, title: title || `YouTube · ${providerId}`, live: false };
  }
  if (host === 'player.twitch.tv') {
    const channel = u.searchParams.get('channel');
    const video = u.searchParams.get('video')?.replace(/^v/, '');
    if (channel && !video && /^[a-zA-Z0-9_]{1,25}$/.test(channel))
      return {
        type: 'twitch',
        providerId: channel,
        title: title || `Twitch · ${channel}`,
        live: true,
      };
    if (video && !channel && /^\d{1,20}$/.test(video))
      return {
        type: 'twitch',
        providerId: video,
        title: title || `Twitch · запись ${video}`,
        live: false,
      };
    throw new AppError(400, 'В iframe Twitch нужен один канал или запись.');
  }
  if (['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(host)) {
    const vod = u.pathname.match(/^\/videos\/(\d{1,20})\/?$/);
    const channel = u.pathname.match(/^\/([a-zA-Z0-9_]{1,25})\/?$/);
    if (vod)
      return {
        type: 'twitch',
        providerId: vod[1],
        title: title || `Twitch · запись ${vod[1]}`,
        live: false,
      };
    if (channel && !['directory', 'downloads', 'settings', 'videos'].includes(channel[1]))
      return {
        type: 'twitch',
        providerId: channel[1],
        title: title || `Twitch · ${channel[1]}`,
        live: true,
      };
  }
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
    const match = u.pathname.match(/^\/(?:video\/)?(\d{1,15})(?:\/([a-f0-9]{6,32}))?\/?$/);
    const hash = match?.[2] || u.searchParams.get('h');
    if (match && (!hash || /^[a-f0-9]{6,32}$/.test(hash))) {
      return {
        type: 'vimeo',
        providerId: match[1],
        url: `https://player.vimeo.com/video/${match[1]}${hash ? `?h=${hash}` : ''}`,
        title: title || `Vimeo · ${match[1]}`,
        live: false,
      };
    }
  }
  // The server never fetches external media. Only HTTPS video resources are accepted.
  const extension = u.pathname.match(/\.(mp4|webm|m4v|mov|ogv|m3u8)$/i)?.[1].toLowerCase();
  if (
    u.protocol === 'https:' &&
    extension &&
    host.includes('.') &&
    !/^[\d.]+$/.test(host) &&
    !host.includes(':') &&
    !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  ) {
    u.hash = '';
    return {
      type: 'remote',
      url: u.href,
      format: extension === 'm3u8' ? 'hls' : 'video',
      title: title || u.pathname.split('/').pop().slice(0, 120),
      live: false,
    };
  }
  throw new AppError(
    400,
    'Поддерживаются YouTube, Twitch, Vimeo, Kodik (kodikplayer.com), их iframe-коды и прямые HTTPS-видеоссылки. Для другого сайта нужен поддерживаемый код плеера; произвольные страницы пока не разбираются.',
  );
}
