import { randomBytes, randomInt, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from './validation.mjs';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export const randomId = () => randomBytes(16).toString('hex');
const digest = (token) => createHash('sha256').update(token).digest('hex');

export class RoomStore {
  constructor(config) {
    this.config = config;
    this.rooms = new Map();
  }
  loadPermanent() {
    let saved;
    try {
      saved = JSON.parse(
        readFileSync(path.join(this.config.dataDir, 'permanent-room.json'), 'utf8'),
      );
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (saved.version !== 1 || !/^[a-f0-9]{32}$/.test(saved.room?.id))
      throw new Error('Invalid permanent room file');
    const room = saved.room;
    room.permanent = true;
    room.expiresAt = Number.MAX_SAFE_INTEGER;
    room.members = new Map(
      room.members.map(([hash, member]) => [hash, { ...member, connections: 0 }]),
    );
    room.sockets = new Set();
    room.clock = performance.now();
    room.playback.playing = false;
    room.uploading = false;
    this.rooms.set(room.id, room);
  }
  persist(room) {
    if (!room.permanent) return;
    const data = { ...room };
    delete data.sockets;
    delete data.clock;
    delete data.uploading;
    data.members = [...room.members].map(([hash, member]) => [hash, { ...member, connections: 0 }]);
    data.playback = {
      ...room.playback,
      position: this.position(room),
      playing: false,
      updatedAt: Date.now(),
    };
    const filename = path.join(this.config.dataDir, 'permanent-room.json');
    writeFileSync(`${filename}.tmp`, JSON.stringify({ version: 1, room: data }), {
      mode: 0o600,
      flush: true,
    });
    renameSync(`${filename}.tmp`, filename);
  }
  makePermanent(room) {
    if (
      [...this.rooms.values()].some((candidate) => candidate.permanent && candidate.id !== room.id)
    )
      throw new AppError(409, 'На сервере уже есть постоянная комната.');
    const previous = { permanent: room.permanent, expiresAt: room.expiresAt };
    room.permanent = true;
    room.expiresAt = Number.MAX_SAFE_INTEGER;
    try {
      this.persist(room);
    } catch (error) {
      Object.assign(room, previous);
      throw error;
    }
  }
  leave(room, member) {
    for (const [hash, value] of room.members) if (value.id === member.id) room.members.delete(hash);
    for (const socket of room.sockets)
      if (socket.member.id === member.id) socket.close(1000, 'Left room');
    const next =
      [...room.members.values()].find((m) => m.connections > 0) || [...room.members.values()][0];
    if (room.hostId === member.id) room.hostId = next?.id || null;
    if (room.controllerId === member.id) {
      room.controllerId = next?.id || null;
      this.control(room, { ...room.playback, position: this.position(room), playing: false });
    }
    room.revision++;
  }
  create({ name, title, permanent = false }) {
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
    if (permanent) {
      try {
        this.makePermanent(room);
      } catch (error) {
        this.rooms.delete(room.id);
        throw error;
      }
    }
    return { room, ...session };
  }
  get(id) {
    const room = this.rooms.get(id);
    if (!room || room.expiresAt <= Date.now())
      throw new AppError(404, 'Комната не найдена или срок её действия истёк.');
    return room;
  }
  join(room, name) {
    if (room.permanent && room.members.size >= this.config.maxMembers) {
      const oldest = [...room.members]
        .filter(([, m]) => !m.connections && m.id !== room.hostId)
        .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0))[0];
      if (oldest) room.members.delete(oldest[0]);
    }
    if (room.members.size >= this.config.maxMembers)
      throw new AppError(409, 'В комнате уже 32 участника.');
    const token = randomBytes(32).toString('hex');
    const member = { id: randomId(), name, connections: 0, lastSeen: Date.now() };
    room.members.set(digest(token), member);
    if (!room.hostId) room.hostId = member.id;
    return { token, member };
  }
  authenticate(room, token = '') {
    const member = /^[a-f0-9]{64}$/.test(token) ? room.members.get(digest(token)) : null;
    if (!member) throw new AppError(401, 'Войдите в комнату.');
    return member;
  }
  host(room, member) {
    if (member.id !== room.hostId)
      throw new AppError(403, 'Это действие доступно только ведущему.');
  }
  position(room) {
    return (
      room.playback.position +
      (room.playback.playing ? ((performance.now() - room.clock) / 1000) * room.playback.rate : 0)
    );
  }
  control(room, data, member) {
    if (member) this.ensureNotDrawing(room);
    if (
      data.checkpoint &&
      (member?.id !== room.controllerId || data.revision !== room.playbackRevision)
    ) {
      throw new AppError(409, 'Управление уже изменилось.');
    }
    if (data.mediaId !== room.playback.mediaId)
      throw new AppError(409, 'Видео уже изменилось. Повторите действие.');
    const media = room.queue.find((m) => m.id === data.mediaId);
    if (member && (data.sourceVersion || 0) !== (media?.sourceVersion || 0))
      throw new AppError(409, 'Плеер или озвучка уже изменились.');
    if (media?.manual && member) throw new AppError(409, 'Этот внешний плеер управляется вручную.');
    room.playback = {
      mediaId: data.mediaId,
      playing: data.playing,
      rate: ['twitch', 'cvh'].includes(media?.type) ? 1 : data.rate,
      position: media?.live ? 0 : data.position,
      updatedAt: Date.now(),
    };
    room.clock = performance.now();
    if (member) room.controllerId = member.id;
    room.playbackRevision++;
    room.revision++;
  }
  select(room, id, member) {
    this.ensureNotDrawing(room);
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
  changeVariant(room, id, sourceVersion, media, member) {
    this.ensureNotDrawing(room);
    const item = room.queue.find((m) => m.id === id);
    if (
      !item?.catalogUrl ||
      room.playback.mediaId !== id ||
      (item.sourceVersion || 0) !== sourceVersion
    )
      throw new AppError(409, 'Видео или источник уже изменились. Повторите выбор.');
    const position =
      item.episode === media.episode && !item.manual && !media.manual ? this.position(room) : 0;
    const replacement = { ...media, id, sourceVersion: sourceVersion + 1 };
    room.queue[room.queue.indexOf(item)] = replacement;
    room.playback = { mediaId: id, position, playing: false, rate: 1, updatedAt: Date.now() };
    room.clock = performance.now();
    room.controllerId = member.id;
    room.playbackRevision++;
    room.revision++;
  }
  ensureNotDrawing(room) {
    if (room.roulette?.endsAt > Date.now())
      throw new AppError(409, 'Рулетка ещё вращается. Дождитесь результата.');
  }
  nominate(room, mediaId, member) {
    this.ensureNotDrawing(room);
    if (!room.queue.some((m) => m.id === mediaId)) throw new AppError(404, 'Видео не найдено.');
    room.roulette ||= { nominations: [] };
    if (room.roulette.order) throw new AppError(409, 'Ведущий должен начать новый раунд.');
    const nominations = room.roulette.nominations;
    const index = nominations.findIndex((n) => n.mediaId === mediaId && n.memberId === member.id);
    if (index >= 0) nominations.splice(index, 1);
    else {
      if (nominations.filter((n) => n.memberId === member.id).length >= 3)
        throw new AppError(409, 'Можно предложить до трёх вариантов за раунд.');
      if (nominations.length >= 96) throw new AppError(409, 'Рулетка заполнена.');
      nominations.push({ mediaId, memberId: member.id, name: member.name });
    }
    room.revision++;
  }
  draw(room, member) {
    this.host(room, member);
    this.ensureNotDrawing(room);
    if (room.roulette?.order) throw new AppError(409, 'Начните новый раунд.');
    const ids = [...new Set((room.roulette?.nominations || []).map((n) => n.mediaId))].filter(
      (id) => room.queue.some((m) => m.id === id),
    );
    if (ids.length < 2) throw new AppError(409, 'Предложите хотя бы два разных видео.');
    // Unbiased Fisher–Yates: each distinct candidate has an equal chance.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    this.select(room, ids.at(-1), member);
    room.roulette = {
      ...room.roulette,
      id: randomId(),
      order: ids,
      startedAt: Date.now(),
      endsAt: Date.now() + 11000,
    };
    room.revision++;
  }
  resetDraw(room, member) {
    this.host(room, member);
    this.ensureNotDrawing(room);
    room.roulette = { nominations: [] };
    room.revision++;
  }
  snapshot(room, member) {
    return {
      id: room.id,
      title: room.title,
      inviteUrl: this.config.publicOrigin ? `${this.config.publicOrigin}/room/${room.id}` : null,
      expiresAt: room.permanent ? null : room.expiresAt,
      permanent: Boolean(room.permanent),
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
      roulette: room.roulette || { nominations: [] },
      playback: { ...room.playback, position: this.position(room), updatedAt: Date.now() },
      serverTime: Date.now(),
    };
  }
  broadcast(room) {
    this.persist(room);
    for (const socket of room.sockets) {
      if (socket.readyState === 1) {
        if (socket.bufferedAmount > 512 * 1024) socket.close(1013, 'Slow connection');
        else
          socket.send(JSON.stringify({ type: 'state', room: this.snapshot(room, socket.member) }));
      }
    }
  }
}
