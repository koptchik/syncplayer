// Kodik's public iframe protocol. Commands stay on the exact trusted origin.
export function createKodikAdapter(mount, media, { changed, ended, blocked }) {
  const origin = new URL(media.url).origin;
  const frame = document.createElement('iframe');
  frame.title = media.title;
  frame.allow = 'autoplay; fullscreen; picture-in-picture';
  frame.allowFullscreen = true;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  const state = { position: 0, playing: false, rate: 1, duration: 0 };
  let at = performance.now();
  let destroyed = false;
  let pendingSeek = null;
  let pendingRate = null;
  let playTimer;
  let loadTimer;
  let finishLoad;
  const currentPosition = () =>
    state.position + (state.playing ? ((performance.now() - at) / 1000) * state.rate : 0);
  const update = (values) => {
    state.position = currentPosition();
    Object.assign(state, values);
    at = performance.now();
  };
  const send = (method, values = {}) => {
    if (!destroyed)
      frame.contentWindow?.postMessage(
        { key: 'kodik_player_api', value: { method, ...values } },
        origin,
      );
  };
  const number = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 864000;
  const receive = (event) => {
    if (destroyed || event.origin !== origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    const { key, value } = message;
    if (['kodik_player_time_update', 'kodik_player_time'].includes(key) && number(value)) {
      update({ position: value });
    } else if (key === 'kodik_player_duration_update' && number(value)) {
      state.duration = value;
    } else if (key === 'kodik_player_video_started') {
      if (pendingSeek !== null) send('seek', { seconds: pendingSeek });
      if (pendingRate !== null) send('speed', { speed: pendingRate });
      pendingSeek = pendingRate = null;
    } else if (key === 'kodik_player_play' || key === 'kodik_player_pause') {
      update({ playing: key === 'kodik_player_play' });
      clearTimeout(playTimer);
      blocked(false);
      changed(state.playing ? 'play' : 'pause');
    } else if (key === 'kodik_player_seek' && number(value)) {
      update({ position: value });
      pendingSeek = null;
      changed('seeked');
    } else if (
      key === 'kodik_player_speed_change' &&
      [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(value)
    ) {
      update({ rate: value });
      pendingRate = null;
      changed('ratechange');
    } else if (key === 'kodik_player_video_ended') {
      update({ playing: false });
      ended();
    }
  };
  window.addEventListener('message', receive);
  const loaded = new Promise((resolve, reject) => {
    finishLoad = resolve;
    loadTimer = setTimeout(
      () =>
        reject(
          new Error('Kodik не ответил. Проверьте доступность плеера и нажмите «Синхронизировать».'),
        ),
      20000,
    );
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(loadTimer);
        resolve();
      },
      { once: true },
    );
  });
  frame.src = media.url;
  mount.append(frame);
  const poll = setInterval(() => send('get_time'), 1000);
  return {
    loaded,
    state: () => ({ ...state, position: currentPosition() }),
    seek: (seconds) => {
      pendingSeek = seconds;
      update({ position: seconds });
      send('seek', { seconds });
    },
    rate: (speed) => {
      pendingRate = speed;
      send('speed', { speed });
    },
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
      clearTimeout(loadTimer);
      clearTimeout(playTimer);
      clearInterval(poll);
      window.removeEventListener('message', receive);
      finishLoad();
      frame.remove();
    },
  };
}
