import { randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from './validation.mjs';

export const randomId = () => randomBytes(16).toString('hex');
const digest = (token) => createHash('sha256').update(token).digest('hex');

export class RoomStore {
  constructor(config) {
    this.config = config;
    this.rooms = new Map();
  }
  create({ name, title }) {
    if (this.rooms.size >= this.config.maxRooms)
      throw new AppError(503, 'Сервер заполнен. Попробуйте позже.');
    const room = {
      id: randomId(),
      title,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.roomTtlMs,
      members: new Map(),
      queue: [],
      messages: [],
      revision: 0,
      playbackRevision: 0,
      controllerId: null,
      sockets: new Set(),
      playback: { mediaId: null, position: 0, playing: false, rate: 1, updatedAt: Date.now() },
      clock: performance.now(),
    };
    const session = this.join(room, name);
    room.hostId = session.member.id;
    room.controllerId = session.member.id;
    this.rooms.set(room.id, room);
    return { room, ...session };
  }
  get(id) {
    const room = this.rooms.get(id);
    if (!room || room.expiresAt <= Date.now())
      throw new AppError(404, 'Комната не найдена или срок её действия истёк.');
    return room;
  }
  join(room, name) {
    if (room.members.size >= this.config.maxMembers)
      throw new AppError(409, 'В комнате уже 32 участника.');
    const token = randomBytes(32).toString('hex');
    const member = { id: randomId(), name, connections: 0 };
    room.members.set(digest(token), member);
    return { token, member };
  }
  authenticate(room, token = '') {
    const member = /^[a-f0-9]{64}$/.test(token) ? room.members.get(digest(token)) : null;
    if (!member) throw new AppError(401, 'Войдите в комнату.');
    return member;
  }
  host(room, member) {
    if (member.id !== room.hostId)
      throw new AppError(403, 'Добавлять и удалять видео может только ведущий.');
  }
  position(room) {
    return (
      room.playback.position +
      (room.playback.playing ? ((performance.now() - room.clock) / 1000) * room.playback.rate : 0)
    );
  }
  control(room, data, member) {
    if (
      data.checkpoint &&
      (member?.id !== room.controllerId || data.revision !== room.playbackRevision)
    ) {
      throw new AppError(409, 'Управление уже изменилось.');
    }
    if (data.mediaId !== room.playback.mediaId)
      throw new AppError(409, 'Видео уже изменилось. Повторите действие.');
    const media = room.queue.find((m) => m.id === data.mediaId);
    room.playback = {
      mediaId: data.mediaId,
      playing: data.playing,
      rate: media?.type === 'twitch' ? 1 : data.rate,
      position: media?.live ? 0 : data.position,
      updatedAt: Date.now(),
    };
    room.clock = performance.now();
    if (member) room.controllerId = member.id;
    room.playbackRevision++;
    room.revision++;
  }
  select(room, id, member) {
    if (!room.queue.some((m) => m.id === id)) throw new AppError(404, 'Видео не найдено.');
    room.playback = { mediaId: id, position: 0, playing: false, rate: 1, updatedAt: Date.now() };
    room.clock = performance.now();
    if (member) room.controllerId = member.id;
    room.playbackRevision++;
    room.revision++;
  }
  add(room, media) {
    if (room.queue.length >= 100)
      throw new AppError(409, 'В очереди может быть не больше 100 видео.');
    const item = { ...media, id: randomId() };
    room.queue.push(item);
    if (!room.playback.mediaId) this.select(room, item.id);
    room.revision++;
    return item;
  }
  snapshot(room, member) {
    return {
      id: room.id,
      title: room.title,
      inviteUrl: this.config.publicOrigin ? `${this.config.publicOrigin}/room/${room.id}` : null,
      expiresAt: room.expiresAt,
      revision: room.revision,
      playbackRevision: room.playbackRevision,
      controllerId: room.controllerId,
      me: { id: member.id, name: member.name, isHost: member.id === room.hostId },
      members: [...room.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        isHost: m.id === room.hostId,
        online: m.connections > 0,
      })),
      queue: room.queue.map(({ diskName: _diskName, ...m }) => m),
      messages: room.messages,
      playback: { ...room.playback, position: this.position(room), updatedAt: Date.now() },
      serverTime: Date.now(),
    };
  }
  broadcast(room) {
    for (const socket of room.sockets) {
      if (socket.readyState === 1) {
        if (socket.bufferedAmount > 512 * 1024) socket.close(1013, 'Slow connection');
        else
          socket.send(JSON.stringify({ type: 'state', room: this.snapshot(room, socket.member) }));
      }
    }
  }
}
