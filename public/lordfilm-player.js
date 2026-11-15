// This document runs in an opaque sandbox: no room cookies, storage, top navigation or popups.
(() => {
  if (parent === window) return;
  const params = new URLSearchParams(location.search),
    nonce = params.get('nonce');
  const title = params.get('titleId'),
    publisher = params.get('publisherId');
  if (
    !/^[0-9]{1,10}$/.test(title || '') ||
    !/^[0-9]{1,10}$/.test(publisher || '') ||
    !/^[a-f0-9-]{36}$/.test(nonce || '')
  )
    return;
  const emit = (key, value) => parent.postMessage({ key, value, nonce }, '*');
  const element = document.createElement('video-player');
  for (const [key, value] of Object.entries({
    'data-title-id': title,
    'data-publisher-id': publisher,
    'data-aggregator': 'kp',
    ident: 'syncplayer',
    'auto-switch': 'false',
  }))
    element.setAttribute(key, value);
  document.body.append(element);
  let ready = false;
  element.addEventListener('ready', () => {
    ready = true;
    document.getElementById('status').hidden = true;
    emit('syncplayer_ready');
  });
  element.addEventListener('error', () => {
    const status = document.getElementById('status');
    status.hidden = false;
    status.textContent =
      'Источник не отдаёт видео: возможны ограничения доступа или CORS. Попробуйте другой фильм или поддерживаемый iframe.';
    emit('syncplayer_error');
  });
  element.addEventListener('playStart', () => emit('player_video_started'));
  element.addEventListener('changeState', (event) => {
    if (event.detail?.state === 'playing') emit('player_play');
    if (event.detail?.state === 'paused') emit('player_pause');
  });
  element.addEventListener('currentTime', (event) =>
    emit('player_time_update', event.detail?.time),
  );
  element.addEventListener('durationChange', (event) =>
    emit('player_duration_update', event.detail?.duration),
  );
  element.addEventListener('playComplete', () => emit('player_video_ended'));
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.nonce !== nonce || !ready) return;
    const { method, seconds } = event.data;
    if (['play', 'pause'].includes(method)) element.messageBridge?.send(method);
    if (method === 'seek' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 864000)
      element.messageBridge?.send('seekTime', { position: seconds });
  });
  const script = document.createElement('script');
  script.src = 'https://player.cdnvideohub.com/s2/stable/video-player.umd.js';
  script.onerror = () => {
    document.getElementById('status').textContent = 'CVH недоступен. Проверьте доступ к источнику.';
    emit('syncplayer_error');
  };
  document.head.append(script);
})();
