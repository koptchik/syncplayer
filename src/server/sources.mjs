import { AppError, parseSource, sourceSchema } from './validation.mjs';
import { yummyPath, catalogMedia } from './yummy.mjs';
import { lordfilmPath, createLordfilmResolver } from './lordfilm.mjs';

// A supported format is not a guarantee of availability, codecs or embedding permission.
// Inspection is deliberately network-free. Only resolve() may call the fixed Yummy adapter.
export function isCatalogSource(url) {
  try {
    yummyPath(url);
    return true;
  } catch {
    return false;
  }
}
export function isLordfilmSource(url) {
  try {
    lordfilmPath(url);
    return true;
  } catch {
    return false;
  }
}
function describe(media) {
  const sourceUrl =
    media.url ||
    (media.type === 'youtube'
      ? `https://www.youtube.com/watch?v=${media.providerId}`
      : `https://www.twitch.tv/${media.live ? '' : 'videos/'}${media.providerId}`);
  return {
    provider: media.type === 'remote' ? (media.format === 'hls' ? 'hls' : 'video') : media.type,
    sourceUrl,
    title: media.title,
    ...(media.type === 'youtube'
      ? { thumbnail: `https://i.ytimg.com/vi/${media.providerId}/hqdefault.jpg` }
      : {}),
    playbackMode: media.manual ? 'manual' : media.type === 'remote' ? 'native' : 'embed',
    supported: true,
    reason: media.manual
      ? 'Внешний плеер: каждый управляет просмотром вручную. Автоматической синхронизации нет.'
      : media.type === 'remote'
        ? 'Формат ссылки поддерживается. Доступность и кодеки проверяются при просмотре; HLS требует CORS у источника.'
        : media.live
          ? 'Канал поддерживается. Задержка прямого эфира у участников может различаться.'
          : 'Формат ссылки поддерживается. Доступность видео и разрешение на встраивание зависят от источника.',
  };
}
export function inspectSource(input) {
  const parsed = sourceSchema.parse(input);
  if (isLordfilmSource(parsed.url))
    return {
      provider: 'lordfilm',
      sourceUrl: `https://8.lordfilms.mobile${lordfilmPath(parsed.url)}`,
      title: parsed.title || 'Фильм LordFilm',
      playbackMode: 'embed',
      supported: true,
      reason:
        'Страница поддерживается через CVH. Доступность видео проверяется при просмотре. Alloha на этой странице не используется; запреты провайдера не обходятся.',
    };
  if (isCatalogSource(parsed.url))
    return {
      provider: 'yummy',
      sourceUrl: `https://old.yummyani.me${yummyPath(parsed.url)}`,
      title: parsed.title || 'Каталог YummyAnime',
      playbackMode: 'catalog',
      supported: true,
      reason:
        'Страница каталога поддерживается. Список видео загрузится при добавлении; плеер, озвучка и серия выбираются во время просмотра.',
    };
  try {
    return describe(parseSource(parsed));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return {
      provider: 'unknown',
      sourceUrl: null,
      title: '',
      playbackMode: 'unsupported',
      supported: false,
      reason: error.message,
    };
  }
}
export function createSourceResolver(resolveCatalog, resolveLordfilm = createLordfilmResolver()) {
  return {
    inspect: inspectSource,
    async resolve(input) {
      const parsed = sourceSchema.parse(input);
      const description = inspectSource(parsed);
      if (!description.supported) throw new AppError(400, description.reason);
      if (description.provider === 'lordfilm') {
        const media = { ...(await resolveLordfilm(description.sourceUrl)) };
        if (parsed.title) media.title = parsed.title;
        return { description: { ...description, title: media.title }, media };
      }
      if (description.provider !== 'yummy') return { description, media: parseSource(parsed) };
      const result = await resolveCatalog(description.sourceUrl);
      const choice =
        result.options.find((o) => o.supported && o.url.startsWith('https://kodikplayer.com/')) ||
        result.options.find((o) => o.supported);
      if (!choice) throw new AppError(400, 'На странице нет поддерживаемых плееров.');
      const media = catalogMedia(description.sourceUrl, result, choice);
      media.catalogTitle = parsed.title || media.catalogTitle;
      return {
        description: {
          ...description,
          title: media.catalogTitle,
          ...(media.poster ? { thumbnail: media.poster } : {}),
          variants: result.options,
        },
        media,
      };
    },
  };
}
