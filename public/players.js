const scripts = new Map();
function loadScript(url, ready) {
  if (ready()) return Promise.resolve();
  if (scripts.has(url)) return scripts.get(url);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    const timer = setTimeout(
      () => reject(new Error('Сервис не ответил. Проверьте интернет и повторите попытку.')),
      20000,
    );
    const poll = setInterval(() => {
      if (ready()) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
    script.onerror = () => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error('Не удалось подключить плеер сервиса.'));
    };
    setTimeout(() => clearInterval(poll), 20500);
    document.head.append(script);
  });
  scripts.set(url, promise);
  promise.catch(() => scripts.delete(url));
  return promise;
}

export class PlayerController {
  constructor(mount, { changed, ended, notice, blocked }) {
    this.mount = mount;
    this.changed = changed;
    this.ended = ended;
    this.notice = notice;
    this.blocked = blocked;
    this.generation = 0;
    this.ignoreUntil = 0;
    this.adapter = null;
    this.mediaId = null;
    this.ready = false;
  }
  event(kind = 'state') {
    if (!this.ready) return;
    if (performance.now() < this.ignoreUntil) {
      if (!this.expected) return;
      const state = this.adapter.state();
      const target =
        this.expected.position +
        (this.expected.playing
          ? ((performance.now() - this.expected.at) / 1000) * this.expected.rate
          : 0);
      const samePosition = Math.abs(state.position - target) < 0.8;
      if ((kind === 'seeked' || kind === 'seek') && samePosition) return;
      if (kind === 'ratechange' && state.rate === this.expected.rate) return;
      if (
        !['seeked', 'seek', 'ratechange'].includes(kind) &&
        state.playing === this.expected.playing &&
        samePosition
      )
        return;
    }
    this.changed();
  }
  state() {
    return this.ready && this.adapter ? this.adapter.state() : null;
  }
  async load(media, roomId) {
    const generation = ++this.generation;
    this.ready = false;
    this.expected = null;
    this.adapter?.destroy();
    this.adapter = null;
    this.mediaId = media?.id || null;
    this.mount.replaceChildren();
    this.blocked(false);
    if (!media) return;
    this.notice('Подключаем видео…');
    const current = () => generation === this.generation;
    try {
      if (media.type === 'file') {
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = `/api/rooms/${roomId}/media/${media.id}`;
        video.setAttribute('aria-label', media.title);
        this.mount.append(video);
        this.adapter = {
          state: () => ({
            position: video.currentTime || 0,
            playing: !video.paused && !video.ended,
            rate: video.playbackRate,
            duration: video.duration,
          }),
          seek: (n) => {
            video.currentTime = n;
          },
          rate: (n) => {
            video.playbackRate = n;
          },
          play: () => video.play(),
          pause: () => video.pause(),
          destroy: () => {
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.remove();
          },
        };
        for (const event of ['play', 'pause', 'seeked', 'ratechange'])
          video.addEventListener(event, () => {
            if (current()) this.event(event);
          });
        video.addEventListener('ended', () => {
          if (current() && this.ready) this.ended();
        });
        video.addEventListener('error', () => {
          if (current())
            this.notice(
              'Браузер не смог прочитать видео. Попробуйте MP4 с видео H.264 и звуком AAC или WebM.',
            );
        });
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  'Видео загружается слишком долго. Проверьте соединение и нажмите «Синхронизировать».',
                ),
              ),
            30000,
          );
          video.addEventListener(
            'loadedmetadata',
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
          video.addEventListener(
            'error',
            () => {
              clearTimeout(timeout);
              reject(
                new Error(
                  'Формат или кодек видео не поддерживается браузером. Рекомендуем MP4 (H.264/AAC) или WebM.',
                ),
              );
            },
            { once: true },
          );
        });
      } else if (media.type === 'youtube') {
        await loadScript('https://www.youtube.com/iframe_api', () => Boolean(window.YT?.Player));
        if (!current()) return;
        const target = document.createElement('div');
        this.mount.append(target);
        let player;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('YouTube не ответил. Проверьте доступность сервиса.')),
            20000,
          );
          player = new window.YT.Player(target, {
            width: '100%',
            height: '100%',
            host: 'https://www.youtube-nocookie.com',
            videoId: media.providerId,
            playerVars: { autoplay: 0, playsinline: 1, origin: location.origin, rel: 0 },
            events: {
              onReady: () => {
                clearTimeout(timeout);
                resolve();
              },
              onStateChange: (event) => {
                if (!current()) return;
                this.event();
                if (event.data === 0 && this.ready) this.ended();
              },
              onPlaybackRateChange: () => {
                if (current()) this.event('ratechange');
              },
              onAutoplayBlocked: () => {
                if (current()) this.blocked(true);
              },
              onError: (event) => {
                clearTimeout(timeout);
                const error = new Error(
                  `YouTube не может воспроизвести видео (код ${event.data}). Возможно, автор запретил встраивание или видео недоступно.`,
                );
                if (current()) this.notice(error.message);
                reject(error);
              },
            },
          });
          this.adapter = {
            state: () => ({
              position: player.getCurrentTime?.() || 0,
              playing: [1, 3].includes(player.getPlayerState?.()),
              rate: player.getPlaybackRate?.() || 1,
              duration: player.getDuration?.() || 0,
            }),
            seek: (n) => player.seekTo(n, true),
            rate: (n) => player.setPlaybackRate(n),
            play: () => player.playVideo(),
            pause: () => player.pauseVideo(),
            destroy: () => player.destroy(),
          };
        });
      } else {
        if (
          location.protocol !== 'https:' &&
          !['localhost', '127.0.0.1'].includes(location.hostname)
        ) {
          throw new Error('Для просмотра Twitch откройте комнату через HTTPS на домене сервера.');
        }
        await loadScript('https://player.twitch.tv/js/embed/v1.js', () =>
          Boolean(window.Twitch?.Player),
        );
        if (!current()) return;
        const target = document.createElement('div');
        target.id = `twitch-${generation}`;
        this.mount.append(target);
        const player = new window.Twitch.Player(target.id, {
          width: '100%',
          height: '100%',
          parent: [location.hostname],
          autoplay: false,
          ...(media.live ? { channel: media.providerId } : { video: `v${media.providerId}` }),
        });
        this.adapter = {
          state: () => ({
            position: player.getCurrentTime() || 0,
            playing: !player.isPaused(),
            rate: 1,
            duration: player.getDuration() || 0,
          }),
          seek: (n) => {
            if (!media.live) player.seek(n);
          },
          rate: () => {},
          play: () => player.play(),
          pause: () => player.pause(),
          destroy: () => {
            this.mount.replaceChildren();
          },
        };
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(new Error('Twitch не ответил. Для встраивания нужен доступный HTTPS-домен.')),
            20000,
          );
          player.addEventListener(window.Twitch.Player.READY, () => {
            clearTimeout(timeout);
            resolve();
          });
          for (const event of [
            window.Twitch.Player.PLAY,
            window.Twitch.Player.PAUSE,
            window.Twitch.Player.SEEK,
          ])
            player.addEventListener(event, () => {
              if (current()) this.event(event === window.Twitch.Player.SEEK ? 'seeked' : 'state');
            });
          player.addEventListener(window.Twitch.Player.PLAYBACK_BLOCKED, () => {
            if (current()) this.blocked(true);
          });
          player.addEventListener(window.Twitch.Player.ENDED, () => {
            if (current() && this.ready) this.ended();
          });
          player.addEventListener(window.Twitch.Player.OFFLINE, () => {
            if (current()) this.notice('Канал сейчас не в эфире.');
          });
        });
      }
      if (!current()) return;
      this.ready = true;
      this.ignoreUntil = performance.now() + 800;
      this.notice(
        media.live
          ? 'Прямой эфир: задержка у зрителей может различаться. Сервис не поддерживает точную общую перемотку.'
          : '',
      );
    } catch (error) {
      if (current()) this.notice(error.message);
    }
  }
  async apply(playback, { force = false, skew = 0, live = false } = {}) {
    if (!this.ready || !this.adapter || playback.mediaId !== this.mediaId) return;
    const target = Math.max(
      0,
      playback.position +
        (playback.playing && !live
          ? (Math.max(0, Date.now() + skew - playback.updatedAt) / 1000) * playback.rate
          : 0),
    );
    const state = this.adapter.state();
    this.ignoreUntil = performance.now() + 800;
    this.expected = {
      position:
        Number.isFinite(state.duration) && state.duration > 0
          ? Math.min(target, state.duration)
          : target,
      playing: playback.playing,
      rate: playback.rate,
      at: performance.now(),
    };
    if (!live && (force || Math.abs(state.position - target) > 1.2))
      this.adapter.seek(
        Number.isFinite(state.duration) && state.duration > 0
          ? Math.min(target, state.duration)
          : target,
      );
    if (state.rate !== playback.rate) this.adapter.rate(playback.rate);
    try {
      if (playback.playing && !state.playing) await this.adapter.play();
      else if (!playback.playing && state.playing) this.adapter.pause();
      if (!playback.playing) this.blocked(false);
    } catch (_error) {
      this.blocked(true);
    }
  }
  async unlock(playback, options) {
    this.blocked(false);
    await this.apply(playback, { ...options, force: true });
  }
  pause() {
    this.ignoreUntil = performance.now() + 1000;
    this.adapter?.pause();
  }
}
