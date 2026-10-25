import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server/app.mjs';
import { configuration } from '../src/server/config.mjs';

test('one permanent room survives restart with sessions, queue, chat and protected uploads; leaving revokes membership', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-persist-'));
  let app, base;
  const start = async () => {
    app = await createApplication(
      configuration({ DATA_DIR: dir, PUBLIC_ORIGIN: 'https://stream.example.org' }),
    );
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const call = async (endpoint, { cookie, data, method = data ? 'POST' : 'GET', body } = {}) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: {
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : body,
    });
    return {
      response,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  };
  try {
    await start();
    const created = await call('/api/rooms', { data: { name: 'Host', title: 'Permanent' } });
    const id = created.body.id,
      host = created.cookie,
      endpoint = `/api/rooms/${id}`;
    const joined = await call(`${endpoint}/join`, { data: { name: 'Guest' } });
    const guest = joined.cookie;
    assert.equal(
      (await call(`${endpoint}/permanent`, { cookie: guest, data: {} })).response.status,
      403,
    );
    assert.equal(
      (await call(`${endpoint}/permanent`, { cookie: host, data: {} })).body.permanent,
      true,
    );
    assert.equal(
      (await call('/api/rooms', { data: { name: 'Other', title: 'Other', permanent: true } }))
        .response.status,
      409,
    );
    const form = new FormData();
    form.append('video', new Blob(['sample']), 'sample.mp4');
    const upload = await call(`${endpoint}/upload`, { cookie: guest, method: 'POST', body: form });
    assert.equal(upload.response.status, 201);
    await call(`${endpoint}/chat`, { cookie: guest, data: { text: 'Saved message' } });
    await call(`${endpoint}/control`, {
      cookie: guest,
      data: { mediaId: upload.body.id, position: 30, playing: true, rate: 1 },
    });
    const stored = JSON.parse(await readFile(path.join(dir, 'permanent-room.json'), 'utf8'));
    assert.equal(stored.room.messages[0].text, 'Saved message');
    assert.equal(stored.room.queue.length, 1);
    assert.equal(JSON.stringify(stored).includes(host.split('=')[1]), false);
    assert.equal((await stat(path.join(dir, 'permanent-room.json'))).mode & 0o077, 0);
    const filename = path.join(dir, 'uploads', stored.room.queue[0].diskName);
    await utimes(filename, new Date(0), new Date(0));
    await app.close();
    await start();
    const restored = await call(endpoint, { cookie: host });
    assert.equal(restored.body.id, id);
    assert.equal(restored.body.inviteUrl, created.body.inviteUrl);
    assert.equal(restored.body.permanent, true);
    assert.equal(restored.body.expiresAt, null);
    assert.equal(restored.body.playback.playing, false);
    assert.ok(restored.body.playback.position >= 30);
    assert.equal(restored.body.messages[0].text, 'Saved message');
    assert.equal(restored.body.members.length, 2);
    assert.equal(await readFile(filename, 'utf8'), 'sample');
    assert.equal(
      (await fetch(`${base}${endpoint}/media/${upload.body.id}`, { headers: { Cookie: guest } }))
        .status,
      200,
    );
    await call(`${endpoint}/leave`, { cookie: host, data: {} });
    assert.equal((await call(endpoint, { cookie: host })).response.status, 401);
    assert.equal((await call(endpoint, { cookie: guest })).body.me.isHost, true);
    await call(`${endpoint}/leave`, { cookie: guest, data: {} });
    await app.close();
    await start();
    const next = await call(`${endpoint}/join`, { data: { name: 'New host' } });
    assert.equal(next.body.id, id);
    assert.equal(next.body.me.isHost, true);
    assert.equal(next.body.members.length, 1);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
