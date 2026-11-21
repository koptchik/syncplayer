import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import Busboy from 'busboy';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { RoomStore, randomId } from './rooms.mjs';
import { openUploads, uploadMimeTypes } from './uploads.mjs';
import { createOwner, ownerLogin, ownerPassword, verifyOwner } from './room-owner.mjs';
import { createYummyResolver, catalogMedia, yummyPath } from './yummy.mjs';
import { createSourceResolver, isCatalogSource, isLordfilmSource } from './sources.mjs';
import { createPageDiscovery } from './page-discovery.mjs';
import { createSearchService } from './search.mjs';
import { createMetadataResolver } from './metadata.mjs';
import { ARTWORK_HOSTS } from '../../public/artwork.js';
import { proposeSchedule, actOnSchedule } from './schedule.mjs';
import {
  AppError,
  createSchema,
  joinSchema,
  chatSchema,
  controlSchema,
  idSchema,
} from './validation.mjs';

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const cookieName = 'sp_session';
function sessionToken(req) {
  const value = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`));
  return value?.slice(cookieName.length + 1) || '';
}

export async function createApplication(
  config,
  {
    resolveCatalog = createYummyResolver(),
    resolveLordfilm,
    enrichMedia = createMetadataResolver(),
    searchSources = createSearchService(),
    discoverPage = createPageDiscovery(config.discoveryHosts ?? new Set()),
  } = {},
) {
  const app = express();
  const server = createServer(app);
  const store = new RoomStore(config);
  store.loadPermanent();
  const uploads = await openUploads(config, store.uploadNames());
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
          imgSrc: ["'self'", 'data:', ...ARTWORK_HOSTS.map((host) => `https://${host}`)],
          frameSrc: [
            'https://rutube.ru',
            "'self'",
            'https://player.cdnvideohub.com',
            'https://ru.yummyani.me',
            'https://alloha.yani.tv',
            'https://kodikplayer.com',
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
  const joinLimiter = limiter(60000, 60);
  const ownerLimiter = limiter(60000, 10);
  const chatLimiter = limiter(10000, 15);
  const controlLimiter = limiter(60000, 150);
  const mutationLimiter = limiter(60000, 60);
  const resolveLimiter = limiter(60000, 10);
  const resolvePage = resolveCatalog;
  const sources = createSourceResolver(resolvePage, resolveLordfilm);
  const discoveryLimiter = limiter(60000, 10);
  const inspectLimiter = limiter(60000, 30);
  const searchLimiter = limiter(60000, 10);
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
      maxAge: room.permanent ? 30 * 86400000 : Math.max(0, room.expiresAt - Date.now()),
    });
  }
  function clearSession(req, res, room) {
    res.clearCookie(cookieName, {
      path: `/api/rooms/${room.id}`,
      httpOnly: true,
      sameSite: 'strict',
      secure: req.accessOrigin.startsWith('https:'),
    });
  }
  app.post('/api/rooms', roomLimiter, async (req, res) => {
    const { name, title, permanent, password } = createSchema.parse(req.body);
    const owner = permanent ? await createOwner(name, ownerPassword.parse(password)) : undefined;
    const { room, token, member } = store.create({ name, title, permanent }, owner);
    setSession(req, res, room, token);
    res.status(201).json(store.snapshot(room, member));
  });
  app.post('/api/rooms/:id/join', joinLimiter, (req, res) => {
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
  app.post('/api/rooms/:id/owner/close', ownerLimiter, async (req, res) => {
    const room = store.get(idSchema.parse(req.params.id));
    if (!room.permanent) throw new AppError(404, 'Постоянная комната не найдена.');
    if (!room.owner)
      throw new AppError(409, 'Для этой комнаты администратор сервера должен назначить владельца.');
    if (!(await verifyOwner(room.owner, ownerLogin.parse(req.body))))
      throw new AppError(403, 'Неверный ник или пароль владельца.');
    store.get(room.id);
    store.closePermanent(room);
    clearSession(req, res, room);
    await Promise.all(room.queue.map(({ diskName }) => uploads.remove(diskName)));
    res.json({ ok: true });
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
  app.post('/api/rooms/:id/resolve', resolveLimiter, async (req, res) => {
    if (typeof req.body?.url !== 'string' || req.body.url.length > 2048)
      throw new AppError(400, 'Некорректная ссылка.');
    res.json(await resolvePage(req.body.url));
  });
  app.post('/api/rooms/:id/source/search', searchLimiter, async (req, res) => {
    const result = await searchSources(req.body);
    store.get(req.room.id);
    store.authenticate(req.room, sessionToken(req));
    res.json(result);
  });
  app.post('/api/rooms/:id/source/discover', discoveryLimiter, async (req, res) => {
    const result = await discoverPage(req.body);
    store.get(req.room.id);
    store.authenticate(req.room, sessionToken(req));
    res.json(result);
  });
  app.post('/api/rooms/:id/source/inspect', inspectLimiter, (req, res) => {
    res.json(sources.inspect(req.body));
  });
  async function addSource(req, res) {
    const resolved = await sources.resolve(req.body);
    const media = await enrichMedia(resolved.media, {
      preserveTitle: Boolean(req.body.title?.trim()),
    });
    store.get(req.room.id);
    store.authenticate(req.room, sessionToken(req));
    const item = store.add(req.room, media);
    store.broadcast(req.room);
    res.status(201).json(item);
  }
  app.post('/api/rooms/:id/catalog', resolveLimiter, (req, res, next) => {
    yummyPath(req.body?.url);
    return addSource(req, res).catch(next);
  });
  app.get('/api/rooms/:id/media/:mediaId/options', resolveLimiter, async (req, res) => {
    const media = req.room.queue.find((m) => m.id === idSchema.parse(req.params.mediaId));
    if (!media?.catalogUrl) throw new AppError(404, 'У этого видео нет страницы каталога.');
    res.json(await resolvePage(media.catalogUrl));
  });
  app.post('/api/rooms/:id/media/:mediaId/variant', mutationLimiter, async (req, res) => {
    const id = idSchema.parse(req.params.mediaId);
    if (
      typeof req.body?.variantId !== 'string' ||
      !/^[a-f0-9]{24}$/.test(req.body.variantId) ||
      !Number.isSafeInteger(req.body.sourceVersion) ||
      req.body.sourceVersion < 0
    )
      throw new AppError(400, 'Некорректный выбор источника.');
    const media = req.room.queue.find((m) => m.id === id);
    if (!media?.catalogUrl) throw new AppError(404, 'Страница каталога не найдена.');
    const result = await resolvePage(media.catalogUrl);
    store.get(req.room.id);
    store.authenticate(req.room, sessionToken(req));
    const choice = result.options.find((o) => o.id === req.body.variantId && o.supported);
    if (!choice)
      throw new AppError(409, 'Этот вариант больше не доступен. Обновите список плееров.');
    store.changeVariant(
      req.room,
      id,
      req.body.sourceVersion,
      { ...catalogMedia(media.catalogUrl, result, choice), catalogTitle: media.catalogTitle },
      req.member,
    );
    store.broadcast(req.room);
    res.json(store.snapshot(req.room, req.member));
  });
  app.post('/api/rooms/:id/permanent', mutationLimiter, async (req, res) => {
    store.canPin(req.room, req.member);
    const owner = await createOwner(req.member.name, ownerPassword.parse(req.body?.password));
    store.get(req.room.id);
    store.canPin(req.room, store.authenticate(req.room, sessionToken(req)));
    store.makePermanent(req.room, owner);
    setSession(req, res, req.room, sessionToken(req));
    store.broadcast(req.room);
    res.json(store.snapshot(req.room, req.member));
  });
  app.post('/api/rooms/:id/leave', mutationLimiter, (req, res) => {
    store.leave(req.room, req.member);
    clearSession(req, res, req.room);
    store.broadcast(req.room);
    res.json({ ok: true });
  });
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
  app.post('/api/rooms/:id/roulette/nominate', mutationLimiter, (req, res) => {
    store.nominate(req.room, idSchema.parse(req.body?.mediaId), req.member);
    store.broadcast(req.room);
    res.json(store.snapshot(req.room, req.member));
  });
  app.post('/api/rooms/:id/roulette/draw', mutationLimiter, (req, res) => {
    store.draw(req.room, req.member);
    store.broadcast(req.room);
    res.json(store.snapshot(req.room, req.member));
  });
  app.post('/api/rooms/:id/roulette/reset', mutationLimiter, (req, res) => {
    store.resetDraw(req.room, req.member);
    store.broadcast(req.room);
    res.json(store.snapshot(req.room, req.member));
  });
  app.post('/api/rooms/:id/schedule', mutationLimiter, (req, res) => {
    proposeSchedule(store, req.room, req.member, req.body);
    store.broadcast(req.room);
    res.status(201).json(store.snapshot(req.room, req.member));
  });
  app.post('/api/rooms/:id/schedule/:eventId', mutationLimiter, (req, res) => {
    actOnSchedule(store, req.room, req.member, idSchema.parse(req.params.eventId), req.body);
    store.broadcast(req.room);
    res.json(store.snapshot(req.room, req.member));
  });
  app.post('/api/rooms/:id/control', controlLimiter, (req, res) => {
    store.control(req.room, controlSchema.parse(req.body), req.member);
    store.broadcast(req.room);
    res.json({ ok: true });
  });
  app.post(
    '/api/rooms/:id/media',
    mutationLimiter,
    (req, res, next) => {
      if (isCatalogSource(req.body?.url) || isLordfilmSource(req.body?.url))
        return resolveLimiter(req, res, next);
      next();
    },
    addSource,
  );
  app.post('/api/rooms/:id/select', mutationLimiter, (req, res) => {
    store.select(req.room, idSchema.parse(req.body?.mediaId), req.member);
    store.broadcast(req.room);
    res.json({ ok: true });
  });
  app.delete('/api/rooms/:id/media/:mediaId', hostOnly, mutationLimiter, async (req, res) => {
    store.ensureNotDrawing(req.room);
    const mediaId = idSchema.parse(req.params.mediaId);
    if (req.room.roulette)
      req.room.roulette.nominations = req.room.roulette.nominations.filter(
        (n) => n.mediaId !== mediaId,
      );
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
    await uploads.remove(media.diskName);
    res.json({ ok: true });
  });
  app.get('/api/rooms/:id/media/:mediaId', (req, res, next) => {
    const media = req.room.queue.find((m) => m.id === req.params.mediaId && m.type === 'file');
    if (!media) throw new AppError(404, 'Файл не найден.');
    res.type(media.mime);
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.sendFile(
      media.diskName,
      { root: uploads.directory, dotfiles: 'deny', acceptRanges: true },
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
    if (req.room.uploading) throw new AppError(409, 'Дождитесь завершения текущей загрузки.');
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
    let release;
    let media = null;
    let writtenName;
    let file;
    let problem;
    let finished = false;
    const writes = [];
    const fail = (error) => {
      problem ||= error;
    };
    const abort = () => parser.destroy(new Error('Upload aborted'));
    try {
      release = await uploads.reserve(size);
      if (req.aborted) throw new AppError(400, 'Загрузка прервана.');
      req.once('aborted', abort);
      await new Promise((resolve, reject) => {
        parser.on('file', (field, stream, info) => {
          const title = [...path.basename(String(info.filename || '').replaceAll('\\', '/'))]
            .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
            .join('')
            .slice(0, 160);
          const ext = path.extname(title).toLowerCase();
          if (field !== 'video' || !uploadMimeTypes[ext]) {
            fail(new AppError(400, 'Выберите видео MP4, WebM, MOV или MKV.'));
            stream.resume();
            return;
          }
          const diskName = `${randomId()}${ext}`;
          const partial = `${diskName}.part`;
          media = {
            type: 'file',
            title,
            diskName,
            mime: uploadMimeTypes[ext],
            bytes: 0,
            live: false,
          };
          stream.on('data', (chunk) => {
            media.bytes += chunk.length;
          });
          stream.on('limit', () => fail(new AppError(413, 'Файл превышает допустимый размер.')));
          file = createWriteStream(uploads.path(partial), { flags: 'wx', mode: 0o600 });
          file.once('open', () => {
            writtenName = partial;
          });
          const writing = pipeline(stream, file).catch(fail);
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
      await rename(uploads.path(writtenName), uploads.path(media.diskName));
      writtenName = media.diskName;
      uploads.record(writtenName, file.bytesWritten);
      if (req.room.expiresAt <= Date.now()) throw new AppError(410, 'Срок действия комнаты истёк.');
      store.authenticate(req.room, sessionToken(req));
      const item = store.add(req.room, media);
      finished = true;
      store.broadcast(req.room);
      res.status(201).json({ id: item.id, title: item.title });
    } finally {
      req.off('aborted', abort);
      await Promise.all(writes);
      if (!finished && writtenName) await uploads.remove(writtenName, file.bytesWritten);
      req.room.uploading = false;
      release?.();
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Неизвестный запрос.' }));
  app.get('/vendor/hls.min.js', (_req, res) =>
    res.sendFile(
      fileURLToPath(new URL('../../node_modules/hls.js/dist/hls.min.js', import.meta.url)),
    ),
  );
  app.get('/lordfilm-player.html', (_req, res) => {
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self' https://player.cdnvideohub.com; style-src 'unsafe-inline'; connect-src https:; frame-src https://player.cdnvideohub.com; img-src https: data:; media-src https: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    );
    res.sendFile(path.join(publicDir, 'lordfilm-player.html'));
  });
  app.get('/lordfilm-player.js', (_req, res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(path.join(publicDir, 'lordfilm-player.js'));
  });
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
    try {
      store.broadcast(room);
    } catch (error) {
      console.error('Room persistence failed:', error.message);
    }
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
      member.lastSeen = Date.now();
      if (!store.rooms.has(room.id)) return;
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
      try {
        store.broadcast(room);
      } catch (error) {
        console.error('Room persistence failed:', error.message);
      }
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
        await Promise.all(room.queue.map(({ diskName }) => uploads.remove(diskName)));
      }
      await uploads.prune();
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
      for (const room of store.rooms.values()) store.persist(room);
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
