import { PlayerController } from './players.js';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const routeId = () => location.pathname.match(/^\/room\/([a-f0-9]{32})\/?$/)?.[1];
let room = null;
let socket = null;
let connected = false;
let reconnectTimer;
let reconnectDelay = 1000;
let skew = 0;
let forceNext = true;
let mediaGeneration = 0;
let selectedSource = 'file';
let pendingSource = null;
let joining = false;
let roomUnavailable = false;
let toastTimer;
let upload = null;
let controlTimer;
let controlSending = false;
let pendingControl = null;
let queueSignature = '';
const seenMessages = new Set();
function storedName() {
  try {
    return localStorage.getItem('syncplayer.name') || '';
  } catch {
    return '';
  }
}
function saveName(name) {
  try {
    localStorage.setItem('syncplayer.name', name);
  } catch {
    /* Storage may be disabled. */
  }
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4500);
}
function notice(message) {
  $('#playerNotice').textContent = message;
  $('#playerNotice').hidden = !message;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
async function api(path, body, method = 'POST') {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  });
  const result = await response.json().catch(() => ({ error: 'Сервер вернул неожиданный ответ.' }));
  if (!response.ok) {
    const error = new Error(result.error || 'Не удалось выполнить действие.');
    error.status = response.status;
    throw error;
  }
  return result;
}
const roomApi = (suffix, body, method) => api(`/api/rooms/${room.id}${suffix}`, body, method);
const player = new PlayerController($('#mediaMount'), {
  changed() {
    if (room && connected) scheduleControl();
  },
  async ended() {
    if (!room || room.controllerId !== room.me.id || !connected) return;
    const index = room.queue.findIndex((media) => media.id === room.playback.mediaId);
    const next = room.queue[index + 1];
    if (next) {
      try {
        await roomApi('/select', { mediaId: next.id });
      } catch (error) {
        toast(error.message);
      }
    } else scheduleControl();
  },
  notice,
  blocked(value) {
    $('#unlockPlayback').hidden = !value;
  },
});
function options(force = false) {
  return { force, skew, live: room?.queue.find((m) => m.id === room.playback.mediaId)?.live };
}
function scheduleControl(checkpoint = false) {
  if (!room || !connected || !player.ready) return;
  if (checkpoint && pendingControl && !pendingControl.checkpoint) return;
  const state = player.state();
  if (!state || player.mediaId !== room.playback.mediaId) return;
  pendingControl = {
    mediaId: player.mediaId,
    position: state.position,
    playing: state.playing,
    rate: state.rate,
    checkpoint,
    revision: room.playbackRevision,
  };
  clearTimeout(controlTimer);
  controlTimer = setTimeout(flushControl, 100);
}
async function flushControl() {
  if (controlSending || !pendingControl || !room || !connected || !player.ready) return;
  const command = pendingControl;
  pendingControl = null;
  if (command.mediaId !== room.playback.mediaId) return;
  controlSending = true;
  try {
    await roomApi('/control', command);
  } catch (error) {
    if (error.status !== 409) toast(error.message);
  } finally {
    controlSending = false;
    if (pendingControl) {
      clearTimeout(controlTimer);
      controlTimer = setTimeout(flushControl, 100);
    }
  }
}
function showRoomDialog(join = false) {
  if (roomUnavailable) join = false;
  joining = join;
  $('#roomDialogTitle').textContent = join ? 'Присоединиться к вечеру' : 'Создать комнату';
  $('#roomDialogDescription').textContent = join
    ? 'Представьтесь — друзья уже ждут.'
    : roomUnavailable
      ? 'Эта комната закрыта или удалена после перезапуска сервера. Создайте новую и отправьте друзьям новое приглашение.'
      : 'Пригласите друзей и смотрите вместе.';
  $('#roomSubmit').textContent = join ? 'Войти в комнату' : 'Создать комнату ↗';
  $('#titleLabel').hidden = join;
  $('#titleInput').required = !join;
  $('#nameInput').value = storedName();
  $('#roomError').textContent = '';
  if (!$('#roomDialog').open) $('#roomDialog').showModal();
}
function recoverMissingRoom() {
  const name = $('#nameInput').value;
  roomUnavailable = true;
  connected = false;
  pendingControl = null;
  clearTimeout(controlTimer);
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
  room = null;
  mediaGeneration++;
  player.load(null);
  $('#playerEmpty').hidden = false;
  $('#mediaMount').hidden = true;
  $('#playerFrame').classList.remove('has-media');
  $('#unlockPlayback').hidden = true;
  $('#queueList').replaceChildren();
  $('#queueList').hidden = true;
  $('#queueEmpty').hidden = false;
  $('#queueCount').textContent = '0';
  $('#peopleCount').textContent = '0';
  $('#peopleView').replaceChildren();
  $('#messages').replaceChildren();
  seenMessages.clear();
  queueSignature = '';
  $('#playStatus').textContent = 'Комната недоступна';
  $('#connectionStatus').textContent = 'Создайте новую комнату';
  $('#roomBadge').textContent = 'КОМНАТА ЗАКРЫТА';
  $('#inviteButton span').textContent = 'Создать комнату';
  $('#inviteButton use').setAttribute('href', '#i-plus');
  for (const id of ['#inviteDialog', '#addDialog']) {
    if ($(id).open) $(id).close();
  }
  notice('Прежнее приглашение больше не действует. Для новой комнаты будет создана новая ссылка.');
  showRoomDialog(false);
  if (name) $('#nameInput').value = name;
}
function openAdd(type = 'file') {
  if (!room) {
    pendingSource = type;
    showRoomDialog(Boolean(routeId()));
    return;
  }
  selectedSource = type;
  $$('.add-tabs button').forEach((button) =>
    button.classList.toggle('selected', button.dataset.type === type),
  );
  $('#fileFields').hidden = type !== 'file';
  $('#urlFields').hidden = type === 'file';
  $('#urlInput').required = type !== 'file';
  $('#fileInput').required = type === 'file';
  $('#urlInput').placeholder =
    type === 'twitch'
      ? 'https://www.twitch.tv/channel'
      : type === 'link'
        ? '<iframe src="https://kodikplayer.com/seria/…"></iframe>'
        : 'https://www.youtube.com/watch?v=…';
  $('#sourceHint').textContent =
    type === 'link'
      ? 'Вставьте ссылку или код iframe: Kodik, YouTube, Vimeo, Twitch либо прямая видеоссылка. Для Kodik скопируйте код выбранной серии и озвучки. Автоматический поиск плееров на страницах сайтов пока недоступен.'
      : type === 'twitch'
        ? 'Канал или запись Twitch. Для прямых эфиров задержка у участников может различаться. Нужен HTTPS-домен.'
        : 'Подойдут обычные ссылки, Shorts и youtu.be. Некоторые видео запрещены для встраивания автором.';
  $('#uploadStatus').textContent = '';
  $('#uploadProgress').hidden = true;
  if (!$('#addDialog').open) $('#addDialog').showModal();
}
function openInvite() {
  if (!room) {
    showRoomDialog(Boolean(routeId()));
    return;
  }
  const inviteUrl = room.inviteUrl || `${location.origin}/room/${room.id}`;
  $('#inviteUrl').value = inviteUrl;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(inviteUrl).hostname);
  $('#inviteHint').textContent = local
    ? 'Ссылка localhost работает только на этом устройстве. Для друзей откройте приложение по сетевому адресу сервера или настройте HTTPS-домен (см. README).'
    : 'Любой человек со ссылкой может войти. Комната временная; отправляйте приглашение только своей компании.';
  $('#copyInvite').textContent = 'Скопировать ссылку';
  $('#inviteDialog').showModal();
}
function renderQueue() {
  const signature = JSON.stringify([room.queue, room.playback.mediaId, room.me.isHost]);
  if (signature === queueSignature) return;
  queueSignature = signature;
  $('#queueCount').textContent = room.queue.length;
  $('#queueEmpty').hidden = room.queue.length > 0;
  $('#queueList').hidden = room.queue.length === 0;
  $('#queueList').replaceChildren();
  for (const media of room.queue) {
    const active = media.id === room.playback.mediaId;
    const row = document.createElement('div');
    row.className = `queue-row${active ? ' active' : ''}`;
    row.dataset.mediaId = media.id;
    const button = document.createElement('button');
    button.className = 'queue-play';

    button.setAttribute('aria-label', `Смотреть: ${media.title}`);
    const thumb = document.createElement('span');
    thumb.className = `queue-thumb ${media.type}`;
    thumb.append(
      icon(
        media.type === 'file'
          ? 'folder'
          : ['remote', 'vimeo', 'kodik'].includes(media.type)
            ? 'link'
            : media.type,
      ),
    );
    const text = document.createElement('span');
    text.className = 'queue-text';
    const title = document.createElement('b');
    title.textContent = media.title;
    const detail = document.createElement('small');
    detail.textContent = `${active ? 'Сейчас смотрим · ' : ''}${media.type === 'file' ? `${(media.bytes / 1024 ** 2).toFixed(1)} МБ · файл` : media.type === 'youtube' ? 'YouTube' : media.type === 'kodik' ? 'Kodik' : media.type === 'vimeo' ? 'Vimeo' : media.type === 'remote' ? (media.format === 'hls' ? 'HLS · внешний поток' : 'Видео по ссылке') : media.live ? 'Twitch · прямой эфир' : 'Twitch · запись'}`;
    text.append(title, detail);
    button.append(thumb, text);
    button.addEventListener('click', async () => {
      try {
        await roomApi('/select', { mediaId: media.id });
        forceNext = true;
        await receive(await roomApi('', undefined, 'GET'));
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(button);
    if (room.me.isHost) {
      const remove = document.createElement('button');
      remove.className = 'queue-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Убрать: ${media.title}`);
      remove.addEventListener('click', async () => {
        try {
          await roomApi(`/media/${media.id}`, undefined, 'DELETE');
        } catch (error) {
          toast(error.message);
        }
      });
      row.append(remove);
    }
    $('#queueList').append(row);
  }
}
function renderPeople() {
  $('#peopleCount').textContent = room.members.filter((member) => member.online).length;
  $('#peopleView').replaceChildren();
  for (const member of room.members) {
    const row = document.createElement('div');
    row.className = 'person';
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = member.name.slice(0, 1).toUpperCase();
    const info = document.createElement('div');
    info.className = 'person-info';
    info.textContent = member.name + (member.id === room.me.id ? ' (вы)' : '');
    const role = document.createElement('small');
    role.textContent = `${member.isHost ? 'Ведущий' : 'Зритель'} · ${member.online ? 'В комнате' : 'Не в сети'}`;
    info.append(role);
    const presence = document.createElement('span');
    presence.className = `presence${member.online ? ' online' : ''}`;
    row.append(avatar, info, presence);
    $('#peopleView').append(row);
  }
}
function renderMessages() {
  const view = $('#chatView');
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 100;
  for (const message of room.messages) {
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    const row = document.createElement('div');
    row.className = 'message';
    row.dataset.id = message.id;
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = message.name.slice(0, 1).toUpperCase();
    const content = document.createElement('div');
    content.className = 'message-content';
    const name = document.createElement('strong');
    name.textContent = message.name;
    const time = document.createElement('time');
    time.dateTime = new Date(message.at).toISOString();
    time.textContent = new Date(message.at).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const body = document.createElement('p');
    body.textContent = message.text;
    content.append(name, time, body);
    row.append(avatar, content);
    $('#messages').append(row);
  }
  while ($('#messages').children.length > 100) {
    const first = $('#messages').firstElementChild;
    seenMessages.delete(first.dataset.id);
    first.remove();
  }
  if (atBottom) view.scrollTop = view.scrollHeight;
}
async function receive(nextRoom) {
  if (room && nextRoom.id === room.id && nextRoom.revision < room.revision) return;
  const previousController = room?.controllerId;
  room = nextRoom;
  roomUnavailable = false;
  $('#roomTitle').textContent = room.title;
  document.title = `${room.title} · Syncplayer`;
  $('#profileButton').textContent = room.me.name.slice(0, 2).toUpperCase();
  $('#inviteButton span').textContent = 'Пригласить друзей';
  $('#inviteButton use').setAttribute('href', '#i-users');
  $('#roomBadge').textContent = 'КОМНАТА ОТКРЫТА';
  $('#syncStatus').textContent = 'Управляют все участники';
  const media = room.queue.find((item) => item.id === room.playback.mediaId);
  $('#playStatus').textContent = media ? media.title : 'Готовы к просмотру';
  $('#playerEmpty').hidden = Boolean(media);
  $('#mediaMount').hidden = !media;
  $('#playerFrame').classList.toggle('has-media', Boolean(media));
  renderQueue();
  renderPeople();
  renderMessages();
  if (player.mediaId !== (media?.id || null)) {
    const generation = ++mediaGeneration;
    await player.load(media, room.id);
    if (generation !== mediaGeneration) return;
    if (media) await player.apply(room.playback, options(true));
    forceNext = false;
  } else if (room.controllerId !== room.me.id || previousController !== room.me.id || forceNext) {
    await player.apply(room.playback, options(forceNext));
    forceNext = false;
  }
}
function connect() {
  clearTimeout(reconnectTimer);
  if (!room) return;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${room.id}/socket`,
  );
  socket = ws;
  ws.onopen = () => {
    connected = true;
    reconnectDelay = 1000;
    forceNext = true;
    $('#connectionStatus').textContent = 'Вы в комнате · соединение защищено сессией';
    $('#statusDot').classList.remove('offline');
    ws.send(JSON.stringify({ type: 'ping', at: Date.now() }));
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'pong') skew = message.serverTime - (message.at + Date.now()) / 2;
    if (message.type === 'state') receive(message.room).catch((error) => notice(error.message));
  };
  ws.onclose = (event) => {
    connected = false;
    pendingControl = null;
    clearTimeout(controlTimer);
    player.pause();
    $('#statusDot').classList.add('offline');
    if (event.code === 1008) {
      recoverMissingRoom();
      return;
    }
    $('#connectionStatus').textContent = 'Связь потеряна · переподключаемся…';
    reconnectTimer = setTimeout(async () => {
      try {
        const latest = await roomApi('', undefined, 'GET');
        await receive(latest);
        connect();
      } catch (error) {
        if (error.status === 404) recoverMissingRoom();
        else if (error.status === 401) {
          room = null;
          showRoomDialog(true);
        } else connect();
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(15000, reconnectDelay * 2);
  };
  ws.onerror = () => {};
}
$('#roomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#nameInput').value.trim();
  if (!name) return;
  $('#roomSubmit').disabled = true;
  $('#roomError').textContent = '';
  try {
    const nextRoom = joining
      ? await api(`/api/rooms/${routeId()}/join`, { name })
      : await api('/api/rooms', { name, title: $('#titleInput').value.trim() });
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
      socket = null;
    }
    connected = false;
    clearTimeout(reconnectTimer);
    forceNext = true;
    saveName(name);
    seenMessages.clear();
    $('#messages').replaceChildren();
    queueSignature = '';
    history.replaceState({}, '', `/room/${nextRoom.id}`);
    await receive(nextRoom);
    connect();
    $('#roomDialog').close();
    if (pendingSource) {
      const source = pendingSource;
      pendingSource = null;
      openAdd(source);
    }
  } catch (error) {
    if (joining && error.status === 404) recoverMissingRoom();
    else $('#roomError').textContent = error.message;
  } finally {
    $('#roomSubmit').disabled = false;
  }
});
$('#inviteButton').addEventListener('click', openInvite);
$('#newRoom').addEventListener('click', () => {
  pendingSource = null;
  showRoomDialog(false);
});
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());
$('#profileButton').addEventListener('click', () => {
  if (room) toast(`${room.me.name} · ${room.me.isHost ? 'Вы ведущий комнаты' : 'Вы зритель'}`);
  else showRoomDialog(Boolean(routeId()));
});
$$('[data-close]').forEach((button) =>
  button.addEventListener('click', () => $(`#${button.dataset.close}`).close()),
);
$('#roomDialog').addEventListener('close', () => {
  if (!room) pendingSource = null;
});
$('#copyInvite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#inviteUrl').value);
    $('#copyInvite').textContent = 'Ссылка скопирована ✓';
  } catch {
    $('#inviteUrl').select();
    toast('Выделили ссылку — скопируйте её через меню или Ctrl+C.');
  }
});
for (const id of ['#startAdd', '#addButton', '#queueAdd'])
  $(id).addEventListener('click', () => openAdd());
$$('[data-source]').forEach((button) =>
  button.addEventListener('click', () => openAdd(button.dataset.source)),
);
$$('[data-type]').forEach((button) =>
  button.addEventListener('click', () => {
    if (!upload) openAdd(button.dataset.type);
  }),
);
$('#fileInput').addEventListener('change', () => {
  $('#fileLabel').textContent = $('#fileInput').files[0]?.name || 'Выберите видео с устройства';
});
$('#dropzone').addEventListener('dragover', (event) => {
  event.preventDefault();
  $('#dropzone').classList.add('dragging');
});
$('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('dragging'));
$('#dropzone').addEventListener('drop', (event) => {
  event.preventDefault();
  $('#dropzone').classList.remove('dragging');
  if (event.dataTransfer.files.length && !upload) {
    $('#fileInput').files = event.dataTransfer.files;
    $('#fileInput').dispatchEvent(new Event('change'));
  }
});
$('#mediaForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#mediaSubmit').disabled = true;
  $('#uploadStatus').textContent = '';
  try {
    if (selectedSource === 'file') {
      const file = $('#fileInput').files[0];
      if (!file) throw new Error('Выберите видео.');
      const body = new FormData();
      body.append('video', file);
      $('#uploadProgress').hidden = false;
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        upload = xhr;
        xhr.open('POST', `/api/rooms/${room.id}/upload`);
        xhr.timeout = 3600000;
        xhr.upload.onprogress = (progress) => {
          if (progress.lengthComputable) {
            const percent = Math.round((progress.loaded / progress.total) * 100);
            $('#uploadProgress').value = percent;
            $('#uploadStatus').textContent =
              percent === 100 ? 'Обрабатываем видео…' : `Загружаем видео · ${percent}%`;
          }
        };
        xhr.onload = () => {
          let response;
          try {
            response = JSON.parse(xhr.responseText);
          } catch {
            reject(new Error('Неожиданный ответ сервера.'));
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(response);
          else reject(new Error(response.error || 'Не удалось загрузить файл.'));
        };
        xhr.onerror = () => reject(new Error('Загрузка прервана: проверьте соединение.'));
        xhr.onabort = () => reject(new Error('Загрузка отменена.'));
        xhr.ontimeout = () => reject(new Error('Время загрузки истекло.'));
        xhr.send(body);
      });
    } else
      await roomApi('/media', {
        url: $('#urlInput').value.trim(),
        title: $('#mediaTitleInput').value.trim(),
      });
    upload = null;
    $('#addDialog').close();
    $('#mediaForm').reset();
    $('#fileLabel').textContent = 'Выберите видео с устройства';
    toast('Видео добавлено в очередь');
    await receive(await roomApi('', undefined, 'GET'));
  } catch (error) {
    $('#uploadStatus').textContent = error.message;
  } finally {
    upload = null;
    $('#mediaSubmit').disabled = false;
  }
});
$('#addDialog').addEventListener('close', () => {
  if (upload) upload.abort();
});
async function sendMessage(text) {
  if (!room) {
    toast('Сначала создайте комнату или присоединитесь к друзьям.');
    return false;
  }
  if (!text.trim()) return false;
  try {
    await roomApi('/chat', { text: text.trim() });
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}
$('#chatForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('#chatInput').value;
  if (await sendMessage(value)) {
    if ($('#chatInput').value === value) $('#chatInput').value = '';
  }
});
$$('.reactions button').forEach((button) =>
  button.addEventListener('click', () => sendMessage(button.textContent)),
);
function tab(people) {
  $('#chatView').hidden = people;
  $('#peopleView').hidden = !people;
  $('#chatTab').classList.toggle('selected', !people);
  $('#peopleTab').classList.toggle('selected', people);
  $('#chatTab').setAttribute('aria-selected', String(!people));
  $('#peopleTab').setAttribute('aria-selected', String(people));
}
$('#chatTab').addEventListener('click', () => tab(false));
$('#peopleTab').addEventListener('click', () => tab(true));
$$('.social-tabs button').forEach((button) =>
  button.addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const people = button.id === 'chatTab';
      tab(people);
      $(people ? '#peopleTab' : '#chatTab').focus();
    }
  }),
);
$('#resyncButton').addEventListener('click', async () => {
  if (!room) {
    toast('Сначала создайте комнату.');
    return;
  }
  try {
    const latest = await roomApi('', undefined, 'GET');
    forceNext = true;
    await receive(latest);
    if (room.playback.mediaId && !player.ready) {
      const media = room.queue.find((m) => m.id === room.playback.mediaId);
      await player.load(media, room.id);
    }
    await player.apply(room.playback, options(true));
    toast('Позиция просмотра обновлена');
  } catch (error) {
    toast(error.message);
  }
});
$('#unlockPlayback').addEventListener('click', () => {
  if (room) player.unlock(room.playback, options(true));
});
setInterval(() => {
  if (connected && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
  if (
    room &&
    room.controllerId === room.me.id &&
    connected &&
    player.ready &&
    performance.now() > player.ignoreUntil
  )
    scheduleControl(true);
}, 3000);
window.addEventListener('online', () => {
  if (room && !connected) connect();
});
window.addEventListener('beforeunload', (event) => {
  if (upload) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function initialize() {
  const id = routeId();
  if (!id) return;
  try {
    await receive(await api(`/api/rooms/${id}`, undefined, 'GET'));
    connect();
  } catch (error) {
    if (error.status === 401) showRoomDialog(true);
    else if (error.status === 404) recoverMissingRoom();
    else {
      notice(error.message);
      $('#playStatus').textContent = 'Комната недоступна';
      $('#roomBadge').textContent = 'СОЗДАЙТЕ НОВУЮ КОМНАТУ';
    }
  }
}
initialize();

for (const button of $$('.mobile-tabs button')) {
  button.addEventListener('click', () => {
    const chat = button.dataset.panel === 'chat';
    $('.workspace').classList.toggle('show-chat', chat);
    for (const item of $$('.mobile-tabs button'))
      item.setAttribute('aria-pressed', String(item === button));
  });
}
