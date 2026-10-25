import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server/app.mjs';
import { configuration } from '../src/server/config.mjs';
import { catalog, catalogUrl } from './fixtures/catalog.mjs';
import { parseSource } from '../src/server/validation.mjs';

test('catalog switches keep a single queue item, reject stale commands and survive restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-catalog-'));
  let app, base;
  const start = async () => {
    app = await createApplication(configuration({ DATA_DIR: dir }), {
      resolveCatalog: async () => structuredClone(catalog),
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const call = async (url, cookie, data) => {
    const r = await fetch(base + url, {
      method: data ? 'POST' : 'GET',
      headers: {
        Origin: base,
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
    const made = await call('/api/rooms', null, { name: 'Host', title: 'Room', permanent: true });
    const root = `/api/rooms/${made.body.id}`,
      host = made.cookie;
    const guest = (await call(`${root}/join`, null, { name: 'Guest' })).cookie;
    assert.equal((await call(`${root}/catalog`, null, { url: catalogUrl })).status, 401);
    const media = await call(`${root}/catalog`, guest, { url: catalogUrl });
    assert.equal(media.status, 201);
    assert.equal(media.body.catalogUrl, catalogUrl);
    const id = media.body.id;
    await call(`${root}/control`, host, { mediaId: id, position: 32, playing: false, rate: 1 });
    const switched = await call(`${root}/media/${id}/variant`, guest, {
      variantId: '2'.repeat(24),
      sourceVersion: 0,
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.queue.length, 1);
    assert.equal(switched.body.playback.position, 32);
    assert.equal(switched.body.playback.playing, false);
    assert.equal(
      (
        await call(`${root}/control`, host, {
          mediaId: id,
          sourceVersion: 0,
          position: 0,
          playing: true,
          rate: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(`${root}/media/${id}/variant`, guest, {
          variantId: '3'.repeat(24),
          sourceVersion: 0,
        })
      ).status,
      409,
    );
    const cvh = await call(`${root}/media/${id}/variant`, host, {
      variantId: '3'.repeat(24),
      sourceVersion: 1,
    });
    assert.equal(cvh.body.queue[0].type, 'cvh');
    assert.equal(cvh.body.playback.position, 32);
    await call(`${root}/control`, host, {
      mediaId: id,
      sourceVersion: 2,
      position: 33,
      playing: false,
      rate: 2,
    });
    assert.equal((await call(root, guest)).body.playback.rate, 1);
    const ep2 = await call(`${root}/media/${id}/variant`, guest, {
      variantId: '4'.repeat(24),
      sourceVersion: 2,
    });
    assert.equal(ep2.body.playback.position, 0);
    await app.close();
    await start();
    const restored = (await call(root, guest)).body;
    assert.equal(restored.queue[0].variantId, '4'.repeat(24));
    assert.equal(restored.queue[0].sourceVersion, 3);
    const manual = await call(`${root}/media/${id}/variant`, host, {
      variantId: '5'.repeat(24),
      sourceVersion: 3,
    });
    assert.equal(manual.body.queue[0].manual, true);
    assert.equal(
      (
        await call(`${root}/control`, host, {
          mediaId: id,
          sourceVersion: 4,
          position: 3,
          playing: true,
          rate: 1,
        })
      ).status,
      409,
    );
    assert.equal((await call(`${root}/leave`, host, {})).status, 200);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('additional providers enforce exact host, paths, and normalized parameters', () => {
  assert.equal(parseSource({ url: catalog.options[2].url }).type, 'cvh');
  assert.equal(parseSource({ url: catalog.options[4].url }).manual, true);
  for (const url of [
    catalog.options[2].url.replace('ru.yummyani.me', 'evil.org'),
    catalog.options[2].url.replace('episode=1', 'episode=NaN'),
    catalog.options[4].url.replace('https:', 'http:'),
    'https://ru.yummyani.me/admin?anime_id=123&episode=1&dubbing_code=X',
  ])
    assert.throws(() => parseSource({ url }));
});
