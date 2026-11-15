import { z } from 'zod';
import { AppError } from './validation.mjs';
import { randomId } from './rooms.mjs';

const proposalSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    startsAt: z.string().datetime({ offset: true }),
    timeZone: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    choice: z.enum(['queue', 'roulette']),
    mediaId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
  })
  .strict();
const actionSchema = z
  .object({
    action: z.enum(['vote', 'confirm', 'cancel', 'roulette', 'start']),
    available: z.boolean().optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
const titleOf = (media) => media.catalogTitle || media.title;
export function proposeSchedule(_store, room, member, input) {
  const data = proposalSchema.parse(input);
  const at = Date.parse(data.startsAt);
  if (at <= Date.now() || at > Date.now() + 366 * 86400000)
    throw new AppError(400, 'Выберите будущее время в пределах года.');
  const media = room.queue.find((m) => m.id === data.mediaId);
  if (data.choice === 'queue' && !media) throw new AppError(400, 'Выберите фильм из очереди.');
  if (data.choice === 'roulette' && data.mediaId !== null)
    throw new AppError(400, 'Для рулетки фильм выбирается после розыгрыша.');
  room.schedule ||= [];
  // Remove only old closed entries; future proposals and confirmed dates are retained.
  room.schedule = room.schedule.filter(
    (e) =>
      !(
        ['cancelled', 'started'].includes(e.status) &&
        Date.parse(e.startsAt) < Date.now() - 7 * 86400000
      ),
  );
  if (room.schedule.length >= 40) throw new AppError(409, 'В расписании уже 40 предложений.');
  if (room.schedule.filter((e) => e.authorId === member.id && e.status === 'proposed').length >= 5)
    throw new AppError(409, 'У вас уже пять предложений. Отмените ненужные.');
  const event = {
    ...data,
    id: randomId(),
    startsAt: new Date(at).toISOString(),
    mediaId: media?.id || null,
    mediaTitle: media ? titleOf(media) : null,
    authorId: member.id,
    authorName: member.name,
    status: 'proposed',
    votes: [member.id],
    revision: 0,
    createdAt: Date.now(),
  };
  room.schedule.push(event);
  room.revision++;
  return event;
}
export function actOnSchedule(store, room, member, id, input) {
  const data = actionSchema.parse(input);
  const event = room.schedule?.find((e) => e.id === id);
  if (!event) throw new AppError(404, 'Встреча не найдена.');
  if (event.revision !== data.revision)
    throw new AppError(409, 'Встреча обновилась. Повторите действие.');
  if (['cancelled', 'started'].includes(event.status))
    throw new AppError(409, 'Встреча уже закрыта.');
  if (data.action === 'vote') {
    if (typeof data.available !== 'boolean') throw new AppError(400, 'Укажите, подходит ли время.');
    const members = new Set([...room.members.values()].map((m) => m.id));
    event.votes = event.votes.filter((value) => value !== member.id && members.has(value));
    if (data.available) event.votes.push(member.id);
  } else if (data.action === 'cancel') {
    if (event.authorId !== member.id || event.status !== 'proposed') store.host(room, member);
    event.status = 'cancelled';
  } else {
    store.host(room, member);
    if (data.action === 'confirm') {
      if (Date.parse(event.startsAt) <= Date.now())
        throw new AppError(409, 'Это время уже прошло. Предложите новое.');
      if (event.choice === 'queue' && !room.queue.some((m) => m.id === event.mediaId))
        throw new AppError(409, 'Фильм удалён из очереди. Предложите встречу с другим фильмом.');
      event.status = 'confirmed';
    } else if (data.action === 'roulette') {
      if (event.choice !== 'roulette') throw new AppError(409, 'У этой встречи фильм уже выбран.');
      store.ensureNotDrawing(room);
      const draw = room.roulette;
      const media = room.queue.find((m) => m.id === draw?.order?.at(-1));
      if (!draw?.id || !media)
        throw new AppError(409, 'Сначала проведите рулетку с видео из очереди.');
      event.mediaId = media.id;
      event.mediaTitle = titleOf(media);
      event.rouletteId = draw.id;
    } else if (data.action === 'start') {
      if (event.status !== 'confirmed') throw new AppError(409, 'Сначала подтвердите встречу.');
      if (!event.mediaId) throw new AppError(409, 'Сначала выберите фильм рулеткой.');
      store.select(room, event.mediaId, member);
      event.status = 'started';
    }
  }
  event.revision++;
  room.revision++;
  return event;
}
