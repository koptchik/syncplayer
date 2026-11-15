export const ARTWORK_HOSTS = [
  'i.ytimg.com',
  'static.yani.tv',
  'pic.rtbcdn.ru',
  'i.vimeocdn.com',
  '8.lordfilms.mobile',
];
export function safeArtwork(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ARTWORK_HOSTS.includes(url.hostname) &&
      url.href.length <= 2048
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function mediaArtwork(media) {
  return safeArtwork(
    media.poster ||
      (media.type === 'youtube' ? `https://i.ytimg.com/vi/${media.providerId}/hqdefault.jpg` : ''),
  );
}
