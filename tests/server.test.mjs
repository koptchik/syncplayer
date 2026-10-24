import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { get as httpGet } from 'node:http';
import WebSocket from 'ws';
import { configuration } from '../src/server/config.mjs';
import { createApplication } from '../src/server/app.mjs';
import { parseSource, controlSchema } from '../src/server/validation.mjs';

let application, base, dataDir, host, guest, roomId;
const request = async (
  endpoint,
  { method = 'GET', data, cookie, origin = base, headers = {}, body } = {},
) => {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      Origin: origin,
      ...(data ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: data ? JSON.stringify(data) : body,
  });
  const type = response.headers.get('content-type') || '';
  return {
    response,
    body: type.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer()),
  };
};
const roomPath = (suffix) => `/api/rooms/${roomId}${suffix}`;
const waitFor = async (predicate, timeout = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};
async function openSocket(cookie, origin = base) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + roomPath('/socket'), {
    headers: { Cookie: cookie, Origin: origin },
  });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  return { ws, messages };
}
before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'syncplayer-test-'));
  application = await createApplication({
    ...configuration({ DATA_DIR: dataDir, MAX_FILE_BYTES: '1024', MAX_STORAGE_BYTES: '10000' }),
    maxRooms: 10,
  });
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  base = `http://127.0.0.1:${application.server.address().port}`;
});
after(async () => {
  await application.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('room lifecycle, authorization, media isolation and synchronization', async (t) => {
  await t.test('creates a room and uses scoped HttpOnly cookies', async () => {
    const result = await request('/api/rooms', {
      method: 'POST',
      data: { name: 'Host', title: 'Movie night' },
    });
    assert.equal(result.response.status, 201);
    roomId = result.body.id;
    const cookie = result.response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(cookie.includes(`Path=/api/rooms/${roomId}`));
    host = cookie.split(';')[0];
    assert.equal(result.body.me.isHost, true);
    assert.equal(JSON.stringify(result.body).includes(host.split('=')[1]), false);
  });
  await t.test('blocks cross-origin writes, unknown hosts and unauthenticated reads', async () => {
    assert.equal(
      (
        await request('/api/rooms', {
          method: 'POST',
          origin: 'https://attacker.example',
          data: { name: 'x', title: 'x' },
        })
      ).response.status,
      403,
    );
    assert.equal(
      await new Promise((resolve, reject) => {
        const req = httpGet(
          base + '/api/health',
          { headers: { Host: 'attacker.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
      }),
      403,
    );
    assert.equal((await request(roomPath(''))).response.status, 401);
    assert.equal(
      (await request(roomPath(''), { cookie: 'sp_session=invalid' })).response.status,
      401,
    );
    assert.equal(
      (
        await request(roomPath('/chat'), {
          method: 'POST',
          cookie: host,
          data: { text: 'CSRF' },
          origin: 'null',
        })
      ).response.status,
      403,
    );
  });
  await t.test('joins with an independent session and restores existing membership', async () => {
    const result = await request(roomPath('/join'), {
      method: 'POST',
      data: { name: '<script>alert(1)</script>' },
    });
    assert.equal(result.response.status, 200);
    guest = result.response.headers.get('set-cookie').split(';')[0];
    assert.equal(result.body.me.isHost, false);
    const restored = await request(roomPath('/join'), {
      method: 'POST',
      cookie: guest,
      data: { name: 'Changed' },
    });
    assert.equal(restored.body.me.id, result.body.me.id);
    assert.equal(restored.body.members.length, 2);
  });
  let mediaId;
  await t.test('allows members to add links and control playback', async () => {
    const result = await request(roomPath('/media'), {
      method: 'POST',
      cookie: host,
      data: { url: 'https://youtu.be/aqz-KE-bpKQ', title: 'Example' },
    });
    assert.equal(result.response.status, 201);
    mediaId = result.body.id;
    assert.equal(
      (
        await request(roomPath('/media'), {
          method: 'POST',
          cookie: guest,
          data: { url: 'https://youtu.be/aqz-KE-bpKQ' },
        })
      ).response.status,
      201,
    );
    assert.equal(
      (
        await request(roomPath('/control'), {
          method: 'POST',
          cookie: guest,
          data: { mediaId, position: 0, playing: true, rate: 1 },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (
        await request(roomPath('/media'), {
          method: 'POST',
          cookie: host,
          data: { url: 'http://169.254.169.254/latest/meta-data/' },
        })
      ).response.status,
      400,
    );
    assert.equal(
      (
        await request(roomPath('/control'), {
          method: 'POST',
          cookie: host,
          data: { mediaId: '0'.repeat(32), position: 0, playing: true, rate: 1 },
        })
      ).response.status,
      409,
    );
  });
  await t.test(
    'all members can select videos and stale checkpoints cannot override user actions',
    async () => {
      const earlier = (await request(roomPath(''), { cookie: host })).body;
      const command = { mediaId, position: 42, playing: false, rate: 1.5 };
      assert.equal(
        (await request(roomPath('/control'), { method: 'POST', cookie: guest, data: command }))
          .response.status,
        200,
      );
      let current = (await request(roomPath(''), { cookie: guest })).body;
      assert.equal(current.controllerId, current.me.id);
      assert.equal(current.playback.position, 42);
      assert.equal(
        (
          await request(roomPath('/control'), {
            method: 'POST',
            cookie: host,
            data: {
              ...command,
              position: 0,
              playing: true,
              checkpoint: true,
              revision: earlier.playbackRevision,
            },
          })
        ).response.status,
        409,
      );
      assert.equal(
        (
          await request(roomPath('/control'), {
            method: 'POST',
            cookie: guest,
            data: { ...command, checkpoint: true, revision: earlier.playbackRevision },
          })
        ).response.status,
        409,
      );
      assert.equal(
        (
          await request(roomPath('/control'), {
            method: 'POST',
            cookie: guest,
            data: { ...command, checkpoint: true, revision: current.playbackRevision },
          })
        ).response.status,
        200,
      );
      assert.equal(
        (await request(roomPath('/control'), { method: 'POST', data: command })).response.status,
        401,
      );
      const added = (
        await request(roomPath('/media'), {
          method: 'POST',
          cookie: host,
          data: { url: 'https://youtu.be/aqz-KE-bpKQ', title: 'Second' },
        })
      ).body;
      assert.equal(
        (
          await request(roomPath('/select'), {
            method: 'POST',
            cookie: guest,
            data: { mediaId: added.id },
          })
        ).response.status,
        200,
      );
      current = (await request(roomPath(''), { cookie: host })).body;
      assert.equal(current.playback.mediaId, added.id);
      assert.equal(
        (await request(roomPath('/control'), { method: 'POST', cookie: guest, data: command }))
          .response.status,
        409,
      );
      assert.equal(
        (await request(roomPath('/select'), { method: 'POST', data: { mediaId } })).response.status,
        401,
      );
      await request(roomPath('/select'), { method: 'POST', cookie: guest, data: { mediaId } });
    },
  );
  await t.test(
    'broadcasts authoritative playback and chat to two clients, restores state on reconnect',
    async () => {
      const a = await openSocket(host);
      const b = await openSocket(guest);
      assert.equal(
        (
          await request(roomPath('/control'), {
            method: 'POST',
            cookie: host,
            data: { mediaId, position: 25, playing: true, rate: 1.25 },
          })
        ).response.status,
        200,
      );
      await waitFor(() => b.messages.some((m) => m.type === 'state' && m.room.playback.playing));
      const state = b.messages.findLast((m) => m.type === 'state').room;
      assert.equal(state.playback.mediaId, mediaId);
      assert.ok(state.playback.position >= 25);
      assert.equal(state.playback.rate, 1.25);
      assert.equal(state.members.filter((m) => m.online).length, 2);
      await request(roomPath('/chat'), {
        method: 'POST',
        cookie: guest,
        data: { text: '<img src=x onerror=alert(1)>' },
      });
      await waitFor(() => a.messages.some((m) => m.room?.messages.length));
      assert.equal(
        a.messages.findLast((m) => m.room).room.messages[0].text,
        '<img src=x onerror=alert(1)>',
      );
      const closed = once(b.ws, 'close');
      b.ws.close();
      await closed;
      const reconnected = await openSocket(guest);
      await waitFor(() => reconnected.messages.some((m) => m.room));
      assert.equal(reconnected.messages[0].room.playback.playing, true);
      const hostClosed = once(a.ws, 'close');
      a.ws.close();
      await hostClosed;
      await waitFor(() =>
        reconnected.messages.some((m) => m.room && m.room.controllerId === m.room.me.id),
      );
      assert.equal((await request(roomPath(''), { cookie: guest })).body.playback.playing, true);
      assert.equal(
        (
          await request(roomPath('/control'), {
            method: 'POST',
            cookie: guest,
            data: { mediaId, position: 30, playing: false, rate: 1 },
          })
        ).response.status,
        200,
      );
      assert.equal((await request(roomPath(''), { cookie: guest })).body.playback.playing, false);
      await request(roomPath('/control'), {
        method: 'POST',
        cookie: guest,
        data: { mediaId, position: 30, playing: true, rate: 1 },
      });
      const finalClosed = once(reconnected.ws, 'close');
      reconnected.ws.close();
      await finalClosed;
      await waitFor(() => !application.store.get(roomId).playback.playing);
    },
  );
  await t.test('rejects WebSocket hijacking and missing sessions', async () => {
    for (const [cookie, origin] of [
      [host, 'https://attacker.example'],
      ['', base],
    ]) {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace('http:', 'ws:') + roomPath('/socket'), {
          headers: { Cookie: cookie, Origin: origin },
        });
        ws.on('open', () => {
          ws.close();
          reject(new Error('Unauthorized WebSocket accepted'));
        });
        ws.on('error', (error) => {
          assert.match(error.message, /Unexpected server response: (401|403)/);
          resolve();
        });
      });
    }
  });
  let fileId;
  await t.test('streams uploaded files with Range support only to the same room', async () => {
    const form = new FormData();
    form.append('video', new Blob([Buffer.from('0123456789')], { type: 'video/mp4' }), 'video.mp4');
    const uploaded = await request(roomPath('/upload'), {
      method: 'POST',
      cookie: guest,
      body: form,
    });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
    fileId = uploaded.body.id;
    const media = await request(roomPath(`/media/${fileId}`), {
      cookie: guest,
      headers: { Range: 'bytes=2-5' },
    });
    assert.equal(media.response.status, 206);
    assert.equal(media.body.toString(), '2345');
    assert.equal(media.response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(media.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await request(roomPath(`/media/${fileId}`))).response.status, 401);
    const other = await request('/api/rooms', {
      method: 'POST',
      data: { name: 'Other', title: 'Other room' },
    });
    const otherCookie = other.response.headers.get('set-cookie').split(';')[0];
    assert.equal(
      (await request(roomPath(`/media/${fileId}`), { cookie: otherCookie })).response.status,
      401,
    );
    assert.equal(
      (await request(`/api/rooms/${other.body.id}/media/${fileId}`, { cookie: otherCookie }))
        .response.status,
      404,
    );
    const state = await request(roomPath(''), { cookie: host });
    assert.equal(JSON.stringify(state.body).includes('diskName'), false);
  });
  await t.test(
    'rejects oversized, unsupported, empty and multiple uploads without leaving partial files',
    async () => {
      const before = await readdir(path.join(dataDir, 'uploads'));
      for (const [name, payload, count] of [
        ['bad.html', 'bad', 1],
        ['empty.mp4', '', 1],
        ['big.mp4', 'x'.repeat(2048), 1],
        ['two.mp4', 'video', 2],
      ]) {
        const form = new FormData();
        for (let i = 0; i < count; i++) form.append('video', new Blob([payload]), name);
        const result = await request(roomPath('/upload'), {
          method: 'POST',
          cookie: host,
          body: form,
        });
        assert.ok(
          [400, 413].includes(result.response.status),
          `${name}: ${result.response.status}`,
        );
      }
      assert.deepEqual(await readdir(path.join(dataDir, 'uploads')), before);
      const form = new FormData();
      form.append('video', new Blob(['x']), 'denied.mp4');
      assert.equal(
        (await request(roomPath('/upload'), { method: 'POST', body: form })).response.status,
        401,
      );
    },
  );
  await t.test('deletes media and prevents subsequent access', async () => {
    assert.equal(
      (await request(roomPath(`/media/${fileId}`), { method: 'DELETE', cookie: guest })).response
        .status,
      403,
    );
    assert.equal(
      (await request(roomPath(`/media/${fileId}`), { method: 'DELETE', cookie: host })).response
        .status,
      200,
    );
    assert.equal(
      (await request(roomPath(`/media/${fileId}`), { cookie: host })).response.status,
      404,
    );
    assert.equal((await readdir(path.join(dataDir, 'uploads'))).length, 0);
  });
  await t.test('rejects malformed and excessive input and rate limits chat', async () => {
    assert.equal(
      (
        await request(roomPath('/chat'), {
          method: 'POST',
          cookie: guest,
          data: { text: 'x'.repeat(1001) },
        })
      ).response.status,
      400,
    );
    assert.equal(
      (
        await request(roomPath('/chat'), {
          method: 'POST',
          cookie: guest,
          data: { text: 'x'.repeat(10000) },
        })
      ).response.status,
      413,
    );
    let limited = false;
    for (let i = 0; i < 18; i++) {
      const result = await request(roomPath('/chat'), {
        method: 'POST',
        cookie: guest,
        data: { text: 'hello' },
      });
      if (result.response.status === 429) limited = true;
    }
    assert.ok(limited);
  });
  await t.test(
    'serves the app with restrictive headers without exposing project files',
    async () => {
      const result = await request('/');
      assert.equal(result.response.status, 200);
      assert.match(result.response.headers.get('content-security-policy'), /object-src 'none'/);
      assert.match(
        result.response.headers.get('content-security-policy'),
        /frame-ancestors 'none'/,
      );
      assert.equal((await request('/.env')).response.status, 404);
      assert.equal((await request('/src/server/app.mjs')).response.status, 404);
      assert.equal((await request('/package.json')).response.status, 404);
    },
  );
  await t.test('expired rooms reject access', async () => {
    application.store.get(roomId).expiresAt = Date.now() - 1;
    assert.equal((await request(roomPath(''), { cookie: host })).response.status, 404);
  });
});

test('source parsing rejects provider spoofing, credentials and arbitrary protocols', () => {
  for (const url of [
    'javascript:alert(1)',
    'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ',
    'https://youtube.com@evil.test/watch?v=aqz-KE-bpKQ',
    'file:///etc/passwd',
    'https://youtube.com:444/watch?v=aqz-KE-bpKQ',
    'https://youtu.be/not-an-id',
    'https://twitch.tv/directory',
  ])
    assert.throws(() => parseSource({ url }));
  assert.equal(
    parseSource({ url: 'https://www.youtube.com/shorts/aqz-KE-bpKQ' }).providerId,
    'aqz-KE-bpKQ',
  );
  assert.equal(parseSource({ url: 'https://twitch.tv/videos/12345' }).live, false);
  assert.equal(parseSource({ url: 'https://twitch.tv/twitch' }).live, true);
  for (const position of [-1, Infinity, NaN])
    assert.equal(
      controlSchema.safeParse({ mediaId: 'a'.repeat(32), position, playing: true, rate: 1 })
        .success,
      false,
    );
});

test('external sources are canonicalized and unsafe URLs rejected', () => {
  const remote = parseSource({ url: 'https://cdn.example.org/movie.mp4?token=abc#t=5' });
  assert.equal(remote.type, 'remote');
  assert.equal(remote.url, 'https://cdn.example.org/movie.mp4?token=abc');
  assert.equal(parseSource({ url: 'https://cdn.example.org/stream.M3U8' }).format, 'hls');
  const vimeo = parseSource({ url: 'https://vimeo.com/123456789/abcdef1234' });
  assert.equal(vimeo.type, 'vimeo');
  assert.equal(vimeo.url, 'https://player.vimeo.com/video/123456789?h=abcdef1234');
  for (const url of [
    'http://cdn.example.org/video.mp4',
    'https://127.0.0.1/video.mp4',
    'https://[::1]/video.mp4',
    'https://localhost/video.mp4',
    'https://media.local/video.mp4',
    'https://cdn.example.org:444/video.mp4',
    'https://user:secret@cdn.example.org/video.mp4',
    'https://cdn.example.org/page.html',
    'https://vimeo.com.evil.example/123456789',
  ])
    assert.throws(() => parseSource({ url }), url);
});

test('iframe code imports only a validated player URL without active HTML', () => {
  const url = 'https://kodikplayer.com/seria/1674048/a14f588b93b4bdf705efa9e6f1e81d14/720p';
  const item = parseSource({
    url: `<iframe src="${url}?autoplay=true" onload="alert(1)" allow="camera"></iframe><script>alert(2)</script>`,
  });
  assert.equal(item.type, 'kodik');
  assert.equal(item.url, url);
  assert.equal(JSON.stringify(item).includes('alert'), false);
  assert.equal(
    parseSource({ url: '<iframe src="//www.youtube.com/embed/aqz-KE-bpKQ"></iframe>' }).type,
    'youtube',
  );
  assert.equal(
    parseSource({
      url: '<iframe src="https://player.vimeo.com/video/123456789?h=abcdef1234&amp;autoplay=1"></iframe>',
    }).url,
    'https://player.vimeo.com/video/123456789?h=abcdef1234',
  );
  assert.equal(
    parseSource({
      url: '<iframe src="https://player.twitch.tv/?channel=twitch&amp;parent=example.org"></iframe>',
    }).providerId,
    'twitch',
  );
  for (const code of [
    '<iframe src="javascript:alert(1)"></iframe>',
    `<iframe src="${url}" srcdoc="<script>alert(1)</script>"></iframe>`,
    `<iframe src="${url}"></iframe><iframe src="${url}"></iframe>`,
    '<iframe></iframe>',
    '<script>location="https://kodikplayer.com"</script>',
    url.replace('kodikplayer.com', 'kodikplayer.com.evil.org'),
    url.replace('https:', 'http:'),
    url.replace('/seria/', '/serial/'),
  ])
    assert.throws(() => parseSource({ url: code }), code);
});
