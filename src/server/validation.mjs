import { z } from 'zod';

const name = z.string().trim().min(1).max(40);
export const createSchema = z.object({ name, title: z.string().trim().min(1).max(80) }).strict();
export const joinSchema = z.object({ name }).strict();
export const chatSchema = z.object({ text: z.string().trim().min(1).max(1000) }).strict();
export const controlSchema = z
  .object({
    mediaId: z.string().regex(/^[a-f0-9]{32}$/),
    position: z.number().finite().min(0).max(864000),
    playing: z.boolean(),
    checkpoint: z.boolean().optional().default(false),
    revision: z.number().int().nonnegative().optional(),
    rate: z.number().refine((n) => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(n)),
  })
  .strict();
export const sourceSchema = z
  .object({ url: z.string().max(2048), title: z.string().trim().max(120).optional() })
  .strict();
export const idSchema = z.string().regex(/^[a-f0-9]{32}$/);

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseSource(input) {
  const { url, title } = sourceSchema.parse(input);
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
  let providerId;
  if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'youtu.be',
      'www.youtube-nocookie.com',
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
    'Поддерживаются YouTube, Twitch, Vimeo и прямые HTTPS-ссылки MP4, WebM, M4V, MOV, OGV или M3U8. Для другой страницы нужна прямая ссылка на видео; защищённые видео недоступны.',
  );
}
