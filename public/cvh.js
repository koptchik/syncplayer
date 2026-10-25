// The YummyAnime CVH wrapper exposes method commands and player_* events.
export function createCvhAdapter(mount, media, { changed, ended, blocked }) {
  const origin = new URL(media.url).origin;
  const frame = document.createElement('iframe');
  frame.title = media.title;
  frame.allow = 'autoplay; fullscreen; picture-in-picture';
  frame.allowFullscreen = true;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  const state = { position: 0, playing: false, rate: 1, duration: 0 };
  let at = performance.now(),
    destroyed = false,
    pendingSeek = null,
    seekUntil = 0;
  let timer, playTimer, finishLoad;
  const position = () => state.position + (state.playing ? (performance.now() - at) / 1000 : 0);
  const update = (values) => {
    state.position = position();
    Object.assign(state, values);
    at = performance.now();
  };
  const send = (method, values = {}) => {
    if (!destroyed) frame.contentWindow?.postMessage({ method, ...values }, origin);
  };
  const receive = (event) => {
    if (
      destroyed ||
      event.origin !== origin ||
      event.source !== frame.contentWindow ||
      !event.data ||
      typeof event.data !== 'object'
    )
      return;
    const { key, value } = event.data;
    if (key === 'player_video_started') {
      if (pendingSeek !== null) {
        seekUntil = performance.now() + 2500;
        send('seek', { seconds: pendingSeek });
      }
    } else if (key === 'player_play' || key === 'player_pause') {
      update({ playing: key === 'player_play' });
      clearTimeout(playTimer);
      blocked(false);
      changed(state.playing ? 'play' : 'pause');
    } else if (
      key === 'player_time_update' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 864000
    ) {
      const jumped = Math.abs(position() - value) > 2;
      if (pendingSeek !== null && Math.abs(pendingSeek - value) < 2) pendingSeek = null;
      if (pendingSeek !== null && performance.now() < seekUntil) return;
      pendingSeek = null;
      update({ position: value });
      if (jumped && pendingSeek === null && performance.now() >= seekUntil) changed('seeked');
    } else if (
      key === 'player_duration_update' &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= 864000
    )
      state.duration = value;
    else if (key === 'player_video_ended') {
      update({ playing: false });
      ended();
    }
  };
  window.addEventListener('message', receive);
  const loaded = new Promise((resolve, reject) => {
    finishLoad = resolve;
    timer = setTimeout(() => reject(new Error('CVH не ответил. Попробуйте другой плеер.')), 20000);
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  frame.src = media.url;
  mount.append(frame);
  return {
    loaded,
    state: () => ({ ...state, position: position() }),
    seek: (seconds) => {
      pendingSeek = seconds;
      seekUntil = performance.now() + 2500;
      update({ position: seconds });
      send('seek', { seconds });
    },
    rate: () => {},
    play: () => {
      send('play');
      clearTimeout(playTimer);
      playTimer = setTimeout(() => {
        if (!destroyed && !state.playing) blocked(true);
      }, 4000);
    },
    pause: () => {
      clearTimeout(playTimer);
      send('pause');
    },
    destroy: () => {
      destroyed = true;
      clearTimeout(timer);
      clearTimeout(playTimer);
      window.removeEventListener('message', receive);
      finishLoad();
      frame.remove();
    },
  };
}
