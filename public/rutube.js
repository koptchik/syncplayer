// Rutube official embed protocol: https://rutube.ru/info/embed/
export function createRutubeAdapter(mount, media, { changed, ended, blocked, failed }) {
  const origin = 'https://rutube.ru';
  const frame = document.createElement('iframe');
  frame.title = media.title;
  frame.allow = 'autoplay; fullscreen; picture-in-picture';
  frame.allowFullscreen = true;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  const state = { position: 0, playing: false, rate: 1, duration: 0 };
  let at = performance.now(),
    destroyed = false,
    advertising = false,
    pendingSeek = null,
    seekUntil = 0,
    timer,
    playTimer,
    finishLoad,
    failLoad;
  const position = () =>
    state.position + (state.playing && !advertising ? (performance.now() - at) / 1000 : 0);
  const update = (values) => {
    state.position = position();
    Object.assign(state, values);
    at = performance.now();
  };
  const send = (type, data = {}) => {
    if (!destroyed)
      frame.contentWindow?.postMessage(JSON.stringify({ type: `player:${type}`, data }), origin);
  };
  const number = (value) => Number.isFinite(value) && value >= 0 && value <= 864000;
  const seek = (seconds) => {
    pendingSeek = seconds;
    seekUntil = performance.now() + 2500;
    update({ position: seconds });
    if (!advertising) send('setCurrentTime', { time: seconds });
  };
  const receive = (event) => {
    if (destroyed || event.origin !== origin || event.source !== frame.contentWindow) return;
    let message = event.data;
    if (typeof message === 'string') {
      if (message.length > 16384) return;
      try {
        message = JSON.parse(message);
      } catch {
        return;
      }
    }
    if (!message || typeof message !== 'object') return;
    const data = message.data || {};
    switch (message.type) {
      case 'player:ready':
        clearTimeout(timer);
        finishLoad();
        break;
      case 'player:durationChange':
        if (number(data.duration)) state.duration = data.duration;
        break;
      case 'player:adStart':
        update({});
        advertising = true;
        break;
      case 'player:adEnd':
      case 'player:rollState':
        if (message.type === 'player:rollState' && !['play', 'complete'].includes(data.state))
          break;
        update({});
        advertising = message.type === 'player:rollState' && data.state === 'play';
        if (!advertising && pendingSeek !== null) seek(pendingSeek);
        break;
      case 'player:playStart':
        if (pendingSeek !== null) seek(pendingSeek);
        break;
      case 'player:changeState':
        if (advertising || !['playing', 'paused', 'stopped'].includes(data.state)) break;
        update({ playing: data.state === 'playing' });
        clearTimeout(playTimer);
        blocked(false);
        changed(state.playing ? 'play' : 'pause');
        break;
      case 'player:currentTime':
        if (advertising || !number(data.time)) break;
        if (pendingSeek !== null && Math.abs(data.time - pendingSeek) < 2) pendingSeek = null;
        if (pendingSeek !== null && performance.now() < seekUntil) break;
        pendingSeek = null;
        {
          const jumped = Math.abs(position() - data.time) > 2;
          update({ position: data.time });
          if (jumped && performance.now() >= seekUntil) changed('seeked');
        }
        break;
      case 'player:playComplete':
        if (!advertising) {
          update({ playing: false });
          ended();
        }
        break;
      case 'player:error':
        {
          const message =
            'Rutube не смог открыть видео. Возможны ограничения доступа, региона или встраивания.';
          failLoad(new Error(message));
          failed(message);
        }
        break;
    }
  };
  const loaded = new Promise((resolve, reject) => {
    finishLoad = resolve;
    failLoad = reject;
    timer = setTimeout(
      () =>
        reject(
          new Error('Rutube не ответил. Проверьте доступность видео и нажмите «Синхронизировать».'),
        ),
      20000,
    );
  });
  window.addEventListener('message', receive);
  frame.src = media.url;
  mount.append(frame);
  return {
    loaded,
    state: () => ({ ...state, position: position(), advertising }),
    seek,
    rate: () => {},
    play: () => {
      send('play');
      clearTimeout(playTimer);
      playTimer = setTimeout(() => {
        if (!destroyed && !state.playing && !advertising) blocked(true);
      }, 5000);
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
