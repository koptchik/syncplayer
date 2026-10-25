const $ = (id) => document.getElementById(id);
function card(media) {
  const node = document.createElement('div');
  node.className = 'roulette-card';
  const title = media.catalogTitle || media.title;
  const art = document.createElement('div');
  art.className = 'roulette-art';
  const hue = ([...media.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 90) + 240;
  art.style.setProperty('--art-hue', hue);
  const monogram = document.createElement('span');
  monogram.textContent = title.slice(0, 2).toUpperCase();
  art.append(monogram);
  let poster =
    media.type === 'youtube'
      ? `https://i.ytimg.com/vi/${media.providerId}/hqdefault.jpg`
      : media.poster;
  if (poster) {
    try {
      const url = new URL(poster);
      if (url.protocol !== 'https:' || !['i.ytimg.com', 'static.yani.tv'].includes(url.hostname))
        poster = null;
    } catch {
      poster = null;
    }
  }
  if (poster) {
    const image = document.createElement('img');
    image.src = poster;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    art.append(image);
  }
  const caption = document.createElement('strong');
  caption.textContent = title;
  node.append(art, caption);
  return node;
}
export function createRoulette({ request, add, error }) {
  const dialog = $('rouletteDialog');
  let room,
    signature = '',
    animation,
    lastFrame = 0,
    seenDraw,
    clockOffset = 0,
    phase = '';
  const act = async (action, data) => {
    try {
      await request(action, data);
    } catch (e) {
      error(e.message);
    }
  };
  $('rouletteStart').onclick = () => act('draw');
  $('rouletteReset').onclick = () => act('reset');
  $('rouletteAdd').onclick = () => {
    dialog.close();
    add();
  };
  dialog.addEventListener('close', () => cancelAnimationFrame(animation));
  function renderCandidates() {
    const draw = room.roulette;
    const signatureNext = JSON.stringify([room.queue, draw, room.me]);
    if (signature === signatureNext) return;
    signature = signatureNext;
    $('rouletteCandidates').replaceChildren();
    for (const media of room.queue) {
      const button = document.createElement('button');
      button.className = 'roulette-candidate';
      const nominations = draw.nominations.filter((n) => n.mediaId === media.id);
      const mine = nominations.some((n) => n.memberId === room.me.id);
      button.setAttribute('aria-pressed', String(mine));
      button.setAttribute(
        'aria-label',
        `${mine ? 'Отозвать' : 'Предложить'}: ${media.catalogTitle || media.title}`,
      );
      button.disabled = Boolean(draw.order);
      button.classList.toggle('nominated', nominations.length > 0);
      button.append(card(media));
      const by = document.createElement('small');
      by.textContent = nominations.length
        ? nominations.map((n) => n.name).join(', ')
        : '＋ Предложить';
      button.append(by);
      button.onclick = () => act('nominate', { mediaId: media.id });
      $('rouletteCandidates').append(button);
    }
    $('rouletteHint').textContent = room.queue.length
      ? 'Предложите до трёх видео из очереди. У каждого варианта равный шанс.'
      : 'Добавьте видео в очередь, затем предложите их для рулетки.';
    $('rouletteStart').hidden = !room.me.isHost || Boolean(draw.order);
    $('rouletteStart').disabled = new Set(draw.nominations.map((n) => n.mediaId)).size < 2;
    $('rouletteReset').hidden = !room.me.isHost || !draw.order;
    $('rouletteAdd').hidden = Boolean(draw.order);
    $('rouletteStage').hidden = !draw.order;
    $('rouletteCandidates').hidden = Boolean(draw.order);
    if (!draw.order) {
      $('rouletteStatus').textContent =
        `Предложено: ${new Set(draw.nominations.map((n) => n.mediaId)).size}. ${room.me.isHost ? 'Нужно хотя бы два варианта.' : 'Розыгрыш запускает ведущий.'}`;
      phase = '';
    }
  }
  function tick(now) {
    if (!dialog.open) return;
    animation = requestAnimationFrame(tick);
    if (now - lastFrame < 90 || !room?.roulette.order) return;
    lastFrame = now;
    const draw = room.roulette,
      elapsed = Date.now() + clockOffset - draw.startedAt;
    const progress = Math.max(0, Math.min(1, elapsed / (draw.endsAt - draw.startedAt)));
    const round = Math.min(7, draw.order.length - 1);
    const step = Math.min(round, Math.floor(progress * round));
    const removed =
      step === round ? draw.order.length - 1 : Math.floor((step * (draw.order.length - 1)) / round);
    const survivors = draw.order.slice(removed);
    const nextPhase = `${draw.id}:${step}`;
    const finished = progress >= 1;
    $('rouletteReset').disabled = !finished;
    $('rouletteStage').classList.toggle('finished', finished);
    if (phase !== nextPhase) {
      phase = nextPhase;
      const wheel = $('rouletteWheel');
      // Keep a stable public order so the animation does not reveal the last survivor early.
      const visible = room.queue.filter((m) => survivors.includes(m.id)).slice(0, 10);
      const oldCards = [...wheel.children];
      for (const old of oldCards)
        if (!visible.some((m) => m.id === old.dataset.id)) {
          old.classList.add('eliminated');
          setTimeout(() => old.remove(), 650);
        }
      visible.forEach((media, index) => {
        let node = [...wheel.children].find(
          (c) => c.dataset.id === media.id && !c.classList.contains('eliminated'),
        );
        if (!node) {
          node = card(media);
          node.dataset.id = media.id;
          wheel.append(node);
        }
        node.style.setProperty('--angle', `${(index * 360) / visible.length}deg`);
        node.classList.toggle('winner', finished);
      });
      const winner = room.queue.find((m) => m.id === draw.order.at(-1));
      $('rouletteRemaining').textContent = finished ? '✦' : String(survivors.length);
      $('rouletteStatus').textContent = finished
        ? `Выбор вечера: ${winner?.catalogTitle || winner?.title || 'Видео'}. Закройте окно и нажмите Play!`
        : `Осталось ${survivors.length} из ${draw.order.length} · варианты выбывают…`;
    }
    const cards = [...$('rouletteWheel').children].filter(
      (n) => !n.classList.contains('eliminated'),
    );
    cards.forEach((node, i) =>
      node.classList.toggle(
        'spotlight',
        !finished && i === Math.floor(elapsed / (85 + progress * 180)) % cards.length,
      ),
    );
  }
  const open = () => {
    if (!room) return;
    if (!dialog.open) dialog.showModal();
    cancelAnimationFrame(animation);
    animation = requestAnimationFrame(tick);
  };
  return {
    open,
    update(nextRoom) {
      room = nextRoom;
      clockOffset = room.serverTime - Date.now();
      renderCandidates();
      if (room.roulette.id !== seenDraw) {
        seenDraw = room.roulette.id;
        if (room.roulette.endsAt > room.serverTime) open();
      }
    },
  };
}
