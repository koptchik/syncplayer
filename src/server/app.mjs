import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import Busboy from 'busboy';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { RoomStore, randomId } from './rooms.mjs';
import {
  AppError,
  createSchema,
  joinSchema,
  chatSchema,
  controlSchema,
  idSchema,
  parseSource,
} from './validation.mjs';

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const mimeTypes = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};
const cookieName = 'sp_session';
function sessionToken(req) {
  const value = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`));
  return value?.slice(cookieName.length + 1) || '';
}

export async function createApplication(config) {
  const app = express();
  const server = createServer(app);
  const store = new RoomStore(config);
  const uploadDir = path.join(config.dataDir, 'uploads');
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  let usedBytes = 0;
  let reservedBytes = 0;
  let activeUploads = 0;
  const orphanFiles = new Map();
  for (const name of await readdir(uploadDir)) {
    if (!/^[a-f0-9]{32}\.(mp4|webm|m4v|mov|mkv)$/.test(name)) continue;
    const info = await stat(path.join(uploadDir, name));
    usedBytes += info.size;
    orphanFiles.set(name, { size: info.size, expiresAt: info.mtimeMs + config.roomTtlMs });
  }
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const securityHeaders = (secure) =>
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            'https://www.youtube.com',
            'https://s.ytimg.com',
            'https://player.twitch.tv',
            'https://player.vimeo.com',
          ],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
          frameSrc: [
            'https://www.youtube.com',
            'https://www.youtube-nocookie.com',
            'https://player.twitch.tv',
            'https://player.vimeo.com',
          ],
          connectSrc: ["'self'", 'https:'],
          mediaSrc: ["'self'", 'blob:', 'https:'],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: secure ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      strictTransportSecurity: secure ? { maxAge: 31536000 } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    });
  const localHeaders = securityHeaders(false);
  const publicHeaders = securityHeaders(true);
  app.use((req, res, next) => {
    try {
      req.accessOrigin = expectedOrigin(req);
      const headers = req.accessOrigin.startsWith('https:') ? publicHeaders : localHeaders;
      headers(req, res, next);
    } catch (error) {
      next(error);
    }
  });
  function expectedOrigin(req) {
    const rawHost = req.headers.host;
    if (!rawHost || !/^[a-zA-Z0-9.:[\]-]+$/.test(rawHost))
      throw new AppError(403, 'Недопустимый адрес сервера.');
    let url;
    try {
      url = new URL(`http://${rawHost}`);
    } catch {
      throw new AppError(403, 'Недопустимый адрес сервера.');
    }
    if (config.publicOrigin && url.host === new URL(config.publicOrigin).host) {
      return config.publicOrigin;
    }
    if (!config.allowedHosts.has(url.hostname))
      throw new AppError(403, 'Добавьте адрес сервера в ALLOWED_HOSTS.');
    return url.origin;
  }
  app.use((req, res, next) => {
    try {
      const origin = expectedOrigin(req);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin) {
        throw new AppError(403, 'Запрос с другого сайта запрещён.');
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  const limiter = (windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Слишком много запросов. Подождите немного.' },
    });
  const roomLimiter = limiter(60000, 20);
  const chatLimiter = limiter(10000, 15);
  const controlLimiter = limiter(60000, 150);
  const mutationLimiter = limiter(60000, 60);
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '8kb', type: 'application/json' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  function setSession(req, res, room, token) {
    res.cookie(cookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.accessOrigin.startsWith('https:'),
      path: `/api/rooms/${room.id}`,
      maxAge: Math.max(0, room.expiresAt - Date.now()),
    });
  }
  app.post('/api/rooms', roomLimiter, (req, res) => {
    const { room, token, member } = store.create(createSchema.parse(req.body));
    setSession(req, res, room, token);
    res.status(201).json(store.snapshot(room, member));
  });
  app.post('/api/rooms/:id/join', roomLimiter, (req, res) => {
    const { name } = joinSchema.parse(req.body);
    const room = store.get(idSchema.parse(req.params.id));
    let member;
    try {
      member = store.authenticate(room, sessionToken(req));
    } catch {
      const joined = store.join(room, name);
      member = joined.member;
      setSession(req, res, room, joined.token);
    }
    store.broadcast(room);
    res.json(store.snapshot(room, member));
  });
  app.use('/api/rooms/:id', (req, _res, next) => {
    try {
      req.room = store.get(idSchema.parse(req.params.id));
      req.member = store.authenticate(req.room, sessionToken(req));
      next();
    } catch (error) {
      next(error);
    }
  });
  const hostOnly = (req, _res, next) => {
    try {
      store.host(req.room, req.member);
      next();
    } catch (error) {
      next(error);
    }
  };
  app.get('/api/rooms/:id', (req, res) => res.json(store.snapshot(req.room, req.member)));
  app.post('/api/rooms/:id/chat', chatLimiter, (req, res) => {
    const { text } = chatSchema.parse(req.body);
    req.room.messages.push({
      id: randomId(),
      memberId: req.member.id,
      name: req.member.name,
      text,
      at: Date.now(),
    });
    req.room.messages = req.room.messages.slice(-100);
    req.room.revision++;
    store.broadcast(req.room);
    res.status(201).json({ ok: true });
  });
  app.post('/api/rooms/:id/control', controlLimiter, (req, res) => {
    store.control(req.room, controlSchema.parse(req.body), req.member);
    store.broadcast(req.room);
    res.json({ ok: true });
  });
  app.post('/api/rooms/:id/media', mutationLimiter, (req, res) => {
    const item = store.add(req.room, parseSource(req.body));
    store.broadcast(req.room);
    res.status(201).json(item);
  });
  app.post('/api/rooms/:id/select', mutationLimiter, (req, res) => {
    store.select(req.room, idSchema.parse(req.body?.mediaId), req.member);
    store.broadcast(req.room);
    res.json({ ok: true });
  });
  async function deleteFile(media) {
    if (!media.diskName) return;
    try {
      await unlink(path.join(uploadDir, media.diskName));
      usedBytes = Math.max(0, usedBytes - media.bytes);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not remove expired media:', error.code);
    }
  }
  app.delete('/api/rooms/:id/media/:mediaId', hostOnly, mutationLimiter, async (req, res) => {
    const mediaId = idSchema.parse(req.params.mediaId);
    const index = req.room.queue.findIndex((m) => m.id === mediaId);
    if (index < 0) throw new AppError(404, 'Видео не найдено.');
    const [media] = req.room.queue.splice(index, 1);
    if (req.room.playback.mediaId === mediaId) {
      if (req.room.queue.length)
        store.select(req.room, req.room.queue[Math.min(index, req.room.queue.length - 1)].id);
      else
        req.room.playback = {
          mediaId: null,
          playing: false,
          position: 0,
          rate: 1,
          updatedAt: Date.now(),
        };
    }
    req.room.revision++;
    store.broadcast(req.room);
    await deleteFile(media);
    res.json({ ok: true });
  });
  app.get('/api/rooms/:id/media/:mediaId', (req, res, next) => {
    const media = req.room.queue.find((m) => m.id === req.params.mediaId && m.type === 'file');
    if (!media) throw new AppError(404, 'Файл не найден.');
    res.type(media.mime);
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.sendFile(
      media.diskName,
      { root: uploadDir, dotfiles: 'deny', acceptRanges: true },
      (error) => {
        if (error) next(error);
      },
    );
  });
  app.post('/api/rooms/:id/upload', mutationLimiter, async (req, res) => {
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new AppError(411, 'Не указан размер загрузки.');
    if (size > config.maxFileBytes + 65536)
      throw new AppError(413, 'Файл превышает допустимый размер.');
    if (usedBytes + reservedBytes + size > config.maxStorageBytes)
      throw new AppError(507, 'На сервере закончился лимит хранения.');
    if (req.room.uploading || activeUploads >= 4)
      throw new AppError(409, 'Дождитесь завершения текущей загрузки.');
    if (req.room.queue.length >= 100) throw new AppError(409, 'Очередь заполнена.');
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: config.maxFileBytes, fields: 0, parts: 2, headerPairs: 100 },
      });
    } catch {
      throw new AppError(400, 'Некорректная загрузка файла.');
    }
    req.room.uploading = true;
    reservedBytes += size;
    activeUploads++;
    let media = null;
    let filepath;
    let problem;
    let finished = false;
    const writes = [];
    const fail = (error) => {
      problem ||= error;
    };
    const abort = () => parser.destroy(new Error('Upload aborted'));
    req.once('aborted', abort);
    try {
      await new Promise((resolve, reject) => {
        parser.on('file', (field, stream, info) => {
          const title = [...path.basename(String(info.filename || '').replaceAll('\\', '/'))]
            .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
            .join('')
            .slice(0, 160);
          const ext = path.extname(title).toLowerCase();
          if (field !== 'video' || !mimeTypes[ext]) {
            fail(new AppError(400, 'Выберите видео MP4, WebM, MOV или MKV.'));
            stream.resume();
            return;
          }
          const diskName = `${randomId()}${ext}`;
          filepath = path.join(uploadDir, diskName);
          media = { type: 'file', title, diskName, mime: mimeTypes[ext], bytes: 0, live: false };
          stream.on('data', (chunk) => {
            media.bytes += chunk.length;
          });
          stream.on('limit', () => fail(new AppError(413, 'Файл превышает допустимый размер.')));
          const writing = pipeline(
            stream,
            createWriteStream(filepath, { flags: 'wx', mode: 0o600 }),
          ).catch(fail);
          writes.push(writing);
        });
        for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'])
          parser.on(event, () =>
            fail(new AppError(400, 'За один раз можно загрузить только один файл.')),
          );
        parser.on('error', reject);
        parser.on('close', resolve);
        req.pipe(parser);
      });
      await Promise.all(writes);
      if (problem) throw problem;
      if (!media || !media.bytes) throw new AppError(400, 'Выберите непустой видеофайл.');
      if (req.room.expiresAt <= Date.now()) throw new AppError(410, 'Срок действия комнаты истёк.');
      const item = store.add(req.room, media);
      usedBytes += media.bytes;
      finished = true;
      store.broadcast(req.room);
      res.status(201).json({ id: item.id, title: item.title });
    } finally {
      req.off('aborted', abort);
      await Promise.all(writes);
      if (!finished && filepath) await unlink(filepath).catch(() => {});
      req.room.uploading = false;
      reservedBytes -= size;
      activeUploads--;
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Неизвестный запрос.' }));
  app.get('/vendor/hls.min.js', (_req, res) =>
    res.sendFile(
      fileURLToPath(new URL('../../node_modules/hls.js/dist/hls.min.js', import.meta.url)),
    ),
  );
  app.use(express.static(publicDir, { dotfiles: 'deny', index: 'index.html', maxAge: 0 }));
  app.get('/room/:id', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((_req, res) => res.status(404).type('text').send('Страница не найдена'));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status =
      error instanceof ZodError
        ? 400
        : error.status || (error.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500 && !(error instanceof AppError))
      console.error('Request failed:', error.message);
    res.status(status).json({
      error:
        error instanceof ZodError
          ? 'Проверьте заполненные поля.'
          : status >= 500 && !(error instanceof AppError)
            ? 'Ошибка сервера.'
            : error.message,
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.headers.origin !== expectedOrigin(req)) throw new AppError(403, 'Origin rejected');
      const match = req.url.match(/^\/api\/rooms\/([a-f0-9]{32})\/socket$/);
      if (!match) throw new AppError(404, 'Not found');
      const room = store.get(match[1]);
      const member = store.authenticate(room, sessionToken(req));
      if (member.connections >= 3 || room.sockets.size >= 96)
        throw new AppError(429, 'Too many connections');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.room = room;
        ws.member = member;
        ws.alive = true;
        ws.windowStart = Date.now();
        ws.count = 0;
        wss.emit('connection', ws);
      });
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status || 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  });
  wss.on('connection', (ws) => {
    const { room, member } = ws;
    member.connections++;
    room.sockets.add(ws);
    store.broadcast(room);
    ws.on('error', () => {});
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      if (Date.now() - ws.windowStart > 10000) {
        ws.windowStart = Date.now();
        ws.count = 0;
      }
      if (++ws.count > 30 || isBinary) {
        ws.close(1008, 'Invalid message');
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'ping' || !Number.isFinite(msg.at)) throw new Error();
        ws.send(JSON.stringify({ type: 'pong', at: msg.at, serverTime: Date.now() }));
      } catch {
        ws.close(1008, 'Invalid message');
      }
    });
    ws.on('close', () => {
      room.sockets.delete(ws);
      member.connections--;
      if (member.id === room.controllerId && member.connections === 0) {
        const next = [...room.members.values()].find((candidate) => candidate.connections > 0);
        if (next) {
          room.controllerId = next.id;
          room.playbackRevision++;
          room.revision++;
        } else if (room.playback.playing) {
          store.control(room, { ...room.playback, position: store.position(room), playing: false });
        }
      }
      store.broadcast(room);
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 15000).unref();
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    try {
      for (const room of store.rooms.values()) {
        if (room.expiresAt > Date.now() || room.uploading) continue;
        for (const ws of room.sockets) ws.close(1008, 'Room expired');
        store.rooms.delete(room.id);
        await Promise.all(room.queue.map(deleteFile));
      }
      for (const [name, info] of orphanFiles) {
        if (info.expiresAt > Date.now()) continue;
        await unlink(path.join(uploadDir, name)).catch(() => {});
        usedBytes = Math.max(0, usedBytes - info.size);
        orphanFiles.delete(name);
      }
    } finally {
      cleaning = false;
    }
  };
  const janitor = setInterval(() => {
    cleanup().catch((error) => console.error('Cleanup failed:', error.message));
  }, 60000).unref();
  await cleanup();
  server.headersTimeout = 10000;
  server.requestTimeout = 60 * 60 * 1000;
  server.keepAliveTimeout = 5000;
  return {
    app,
    server,
    store,
    async close() {
      clearInterval(heartbeat);
      clearInterval(janitor);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      if (server.listening)
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeIdleConnections();
        });
    },
  };
}
