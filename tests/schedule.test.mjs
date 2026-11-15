import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from './helpers/application.mjs';
import { configuration } from '../src/server/config.mjs';

test('members propose and vote; host confirms and starts queued films or a roulette winner; schedule persists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-schedule-'));
  let app, base;
  const start = async () => {
    app = await createApplication(configuration({ DATA_DIR: dir }));
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const call = async (url, cookie, data, origin = base) => {
    const r = await fetch(base + url, {
      method: data ? 'POST' : 'GET',
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0],
    };
  };
  try {
    await start();
    const created = await call('/api/rooms', null, {
        name: 'Host',
        title: 'Schedule',
        permanent: true,
      }),
      host = created.cookie,
      root = '/api/rooms/' + created.body.id;
    const guest = (await call(root + '/join', null, { name: 'Guest' })).cookie;
    const one = (await call(root + '/media', host, { url: 'https://media.example.org/one.mp4' }))
      .body;
    const two = (await call(root + '/media', guest, { url: 'https://media.example.org/two.mp4' }))
      .body;
    const proposal = {
      title: 'Movie night',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      timeZone: 'Asia/Tomsk',
      choice: 'queue',
      mediaId: one.id,
    };
    assert.equal((await call(root + '/schedule', null, proposal)).status, 401);
    assert.equal((await call(root + '/schedule', guest, proposal, 'https://evil.org')).status, 403);
    for (const patch of [
      { startsAt: 'tomorrow' },
      { startsAt: '2000-01-01T00:00:00Z' },
      { timeZone: 'Not/AZone' },
      { mediaId: '0'.repeat(32) },
    ])
      assert.equal((await call(root + '/schedule', guest, { ...proposal, ...patch })).status, 400);
    const added = await call(root + '/schedule', guest, proposal);
    assert.equal(added.status, 201);
    let event = added.body.schedule[0];
    const act = async (cookie, action, extra = {}) =>
      call(root + '/schedule/' + event.id, cookie, { action, revision: event.revision, ...extra });
    assert.equal((await act(guest, 'confirm')).status, 403);
    event = (await act(host, 'vote', { available: true })).body.schedule[0];
    assert.equal(event.votes.length, 2);
    event = (await act(host, 'vote', { available: true })).body.schedule[0];
    assert.equal(event.votes.length, 2);
    assert.equal(
      (await call(root + '/schedule/' + event.id, host, { action: 'confirm', revision: 0 })).status,
      409,
    );
    event = (await act(host, 'confirm')).body.schedule[0];
    assert.equal(event.status, 'confirmed');
    assert.equal((await act(guest, 'cancel')).status, 403);
    await app.close();
    await start();
    event = (await call(root, guest)).body.schedule[0];
    assert.equal(event.status, 'confirmed');
    assert.equal(event.timeZone, 'Asia/Tomsk');
    assert.equal(event.votes.length, 2);
    const started = await act(host, 'start');
    assert.equal(started.body.playback.mediaId, one.id);
    assert.equal(started.body.playback.playing, false);
    assert.equal(started.body.schedule[0].status, 'started');
    const next = await call(root + '/schedule', guest, {
      ...proposal,
      title: 'Roulette night',
      choice: 'roulette',
      mediaId: null,
    });
    event = next.body.schedule[1];
    assert.equal((await act(host, 'roulette')).status, 409);
    await call(root + '/roulette/nominate', host, { mediaId: one.id });
    await call(root + '/roulette/nominate', guest, { mediaId: two.id });
    await call(root + '/roulette/draw', host, {});
    assert.equal((await act(host, 'roulette')).status, 409);
    const room = app.store.get(created.body.id);
    room.roulette.endsAt = Date.now() - 1;
    event = (await act(host, 'roulette')).body.schedule[1];
    assert.equal(event.mediaId, room.roulette.order.at(-1));
    const selected = event.mediaId;
    await call(root + '/roulette/reset', host, {});
    assert.equal((await call(root, guest)).body.schedule[1].mediaId, selected);
    event = (await act(host, 'confirm')).body.schedule[1];
    assert.equal((await act(host, 'start')).status, 200);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
