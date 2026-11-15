const $ = (id) => document.getElementById(id);
const statusNames = {
  proposed: 'Обсуждаем',
  confirmed: 'Подтверждено',
  cancelled: 'Отменено',
  started: 'Начали просмотр',
};
export function createSchedule({ request, error, openRoulette }) {
  let room,
    signature = '',
    pending = false;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const format = (value) =>
    new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  $('scheduleZone').textContent =
    `Дата и время показаны в вашем часовом поясе: ${timeZone}. Все видят встречу в своём местном времени.`;
  const act = async (event, action, data = {}) => {
    if (pending) return;
    pending = true;
    try {
      await request(`/${event.id}`, { action, revision: event.revision, ...data });
    } catch (e) {
      error(e.message);
    } finally {
      pending = false;
    }
  };
  const button = (text, handler, disabled = false) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'small-button';
    el.textContent = text;
    el.disabled = disabled;
    el.onclick = handler;
    return el;
  };
  $('scheduleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('meetingError').textContent = '';
    const raw = $('meetingTime').value;
    const at = new Date(raw);
    // datetime-local normalizes nonexistent DST times; reject that silent shift.
    const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (
      !parts ||
      !Number.isFinite(at.getTime()) ||
      [at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes()].some(
        (n, i) => n !== Number(parts[i + 1]),
      )
    ) {
      $('meetingError').textContent = 'Такого времени нет в вашем часовом поясе. Выберите другое.';
      return;
    }
    $('meetingSubmit').disabled = true;
    const value = $('meetingMedia').value;
    try {
      await request('', {
        title: $('meetingTitle').value.trim(),
        startsAt: at.toISOString(),
        timeZone,
        choice: value === 'roulette' ? 'roulette' : 'queue',
        mediaId: value === 'roulette' ? null : value,
      });
      $('scheduleForm').reset();
    } catch (e) {
      $('meetingError').textContent = e.message;
    } finally {
      $('meetingSubmit').disabled = false;
    }
  });
  function render() {
    const events = room.schedule || [];
    const next = events
      .filter(
        (e) => e.status === 'confirmed' && Date.parse(e.startsAt) > room.serverTime - 86400000,
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    $('nextMeeting').hidden = !next;
    if (next)
      $('nextMeeting').textContent =
        `Ближайшая встреча · ${format(next.startsAt)} · ${next.title} · ${next.mediaTitle || 'фильм выберем рулеткой'}`;
    const sig = JSON.stringify([
      events,
      room.queue.map((m) => [m.id, m.catalogTitle || m.title]),
      room.me.id,
      room.me.isHost,
      room.roulette?.id,
      room.roulette?.endsAt,
    ]);
    if (sig === signature) return;
    signature = sig;
    const selected = $('meetingMedia').value;
    $('meetingMedia').replaceChildren(new Option('Выберем рулеткой', 'roulette'));
    for (const media of room.queue)
      $('meetingMedia').append(new Option(media.catalogTitle || media.title, media.id));
    if ([...$('meetingMedia').options].some((o) => o.value === selected))
      $('meetingMedia').value = selected;
    $('meetingList').replaceChildren();
    if (!events.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Пока нет предложений. Запланируйте первый общий вечер.';
      $('meetingList').append(empty);
    }
    for (const event of [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const closed = ['cancelled', 'started'].includes(event.status);
      const row = document.createElement('article');
      row.className = `meeting-card ${event.status}`;
      const header = document.createElement('div');
      header.className = 'meeting-header';
      const title = document.createElement('h3');
      title.textContent = event.title;
      const badge = document.createElement('span');
      badge.className = 'meeting-badge';
      badge.textContent = statusNames[event.status];
      header.append(title, badge);
      const date = document.createElement('time');
      date.dateTime = event.startsAt;
      date.textContent = format(event.startsAt);
      const source = document.createElement('p');
      source.className = 'meeting-movie';
      const stillPresent = room.queue.some((m) => m.id === event.mediaId);
      source.textContent = event.mediaTitle
        ? `${event.choice === 'roulette' ? '✦ Рулетка · ' : ''}${event.mediaTitle}${stillPresent ? '' : ' · удалён из очереди'}`
        : '✦ Фильм выберем рулеткой';
      const meta = document.createElement('p');
      meta.className = 'hint';
      meta.textContent = `Предложил(а) ${event.authorName} · удобно: ${event.votes.length}${event.timeZone !== timeZone ? ` · у автора: ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: event.timeZone }).format(new Date(event.startsAt))} (${event.timeZone})` : ''}`;
      const actions = document.createElement('div');
      actions.className = 'meeting-actions';
      if (!closed) {
        const mine = event.votes.includes(room.me.id);
        const vote = button(mine ? '✓ Мне удобно' : 'Мне удобно', () =>
          act(event, 'vote', { available: !mine }),
        );
        vote.setAttribute('aria-pressed', String(mine));
        actions.append(vote);
        if (room.me.isHost) {
          if (event.status === 'proposed')
            actions.append(button('Подтвердить', () => act(event, 'confirm')));
          if (event.choice === 'roulette') {
            actions.append(button('Открыть рулетку', openRoulette));
            actions.append(
              button(
                'Взять результат рулетки',
                () => act(event, 'roulette'),
                !room.roulette?.order,
              ),
            );
          }
          if (event.status === 'confirmed')
            actions.append(
              button(
                'Начать встречу',
                async () => {
                  await act(event, 'start');
                  if (room.schedule.find((e) => e.id === event.id)?.status === 'started')
                    $('scheduleDialog').close();
                },
                !stillPresent,
              ),
            );
        }
        if (room.me.isHost || (event.authorId === room.me.id && event.status === 'proposed'))
          actions.append(button('Отменить', () => act(event, 'cancel')));
      }
      row.append(header, date, source, meta, actions);
      $('meetingList').append(row);
    }
  }
  return {
    update(next) {
      room = next;
      render();
    },
    open() {
      if (!room) return;
      render();
      if (!$('scheduleDialog').open) $('scheduleDialog').showModal();
    },
  };
}
