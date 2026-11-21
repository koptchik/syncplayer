import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configuration } from '../src/server/config.mjs';
import { createApplication } from './helpers/application.mjs';

const password = 'temporary owner password';
const chatKey = 'stage-two-chat-request';
const mediaKey = 'stage-two-media-request';
const uploadKey = 'stage-two-upload-request';
const source = { url: 'https://example.org/movie.mp4', title: 'Movie' };

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-commit-'));
  let app, origin;
  t.after(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const start = async () => {
    app = await createApplication(configuration({ DATA_DIR: dir }));
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
  };
  const request = async (endpoint, { cookie, data, key, method, form } = {}) => {
    const response = await fetch(origin + endpoint, {
      method: method || (data || form ? 'POST' : 'GET'),
      headers: {
        Origin: origin,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: form || (data ? JSON.stringify(data) : undefined),
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  };
  await start();
  const created = await request('/api/rooms', {
    data: { name: 'Host', title: 'Permanent', permanent: true, password },
  });
  assert.equal(created.status, 201);
  const cookie = created.cookie;
  const endpoint = '/api/rooms/' + created.body.id;
  return {
    cookie,
    dir,
    request,
    call: (suffix, options) => request(endpoint + suffix, { cookie, ...options }),
    close: () => app.close(),
    restart: async () => {
      await app.close();
      await start();
    },
    savedPath: path.join(dir, 'permanent-room.json'),
  };
}

function video(contents = 'sample') {
  const form = new FormData();
  form.append('video', new Blob([contents]), 'sample.webm');
  return form;
}

test('failed permanent changes leave live state, cookies, uploads, and the saved file intact', async (t) => {
  const { call, cookie, savedPath, dir } = await fixture(t);
  const media = await call('/media', { data: source, key: mediaKey });
  assert.equal(media.status, 201);
  const before = await readFile(savedPath, 'utf8');
  const snapshot = (await call('')).body;
  const blockedPath = savedPath + '.tmp';
  // A directory at the temporary path makes the real write fail before atomic replacement.
  await mkdir(blockedPath);
  try {
    for (const [endpoint, options] of [
      ['/chat', { data: { text: 'Retry me' }, key: chatKey }],
      ['/media', { data: { ...source, title: 'Second item' }, key: 'failed-media-request' }],
      ['/upload', { form: video(), key: uploadKey }],
      ['/media/' + media.body.id, { method: 'DELETE' }],
      ['/leave', { data: {} }],
    ]) {
      const rejected = await call(endpoint, options);
      assert.equal(rejected.status, 503, endpoint);
      assert.equal(rejected.cookie, undefined, endpoint);
    }
    const join = await call('/join', { cookie: undefined, data: { name: 'Guest' } });
    assert.equal(join.status, 503);
    assert.equal(join.cookie, undefined);
    const current = await call('', { cookie });
    assert.equal(current.status, 200);
    assert.equal(current.body.revision, snapshot.revision);
    assert.deepEqual(current.body.messages, snapshot.messages);
    assert.deepEqual(current.body.members, snapshot.members);
    assert.deepEqual(current.body.queue, snapshot.queue);
    assert.equal(await readFile(savedPath, 'utf8'), before);
    assert.deepEqual(await readdir(path.join(dir, 'uploads')), []);
  } finally {
    await rmdir(blockedPath);
  }
  const saved = await call('/chat', { data: { text: 'Retry me' }, key: chatKey });
  assert.equal(saved.status, 201);
  assert.equal((await call('')).body.messages.length, 1);
});

test('repeating a confirmed key returns the same result across concurrent requests and restart', async (t) => {
  const { call, restart, savedPath, dir } = await fixture(t);
  const chat = { data: { text: 'Once' }, key: chatKey };
  const link = { data: source, key: mediaKey };
  const [first, second] = await Promise.all([call('/media', link), call('/media', link)]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.id, second.body.id);
  assert.equal((await call('/chat', chat)).status, 201);
  const file = await call('/upload', { form: video(), key: uploadKey });
  assert.equal(file.status, 201);

  await restart();
  assert.equal((await call('/chat', chat)).status, 201);
  assert.deepEqual((await call('/media', link)).body, first.body);
  assert.deepEqual((await call('/upload', { form: video(), key: uploadKey })).body, file.body);
  assert.equal((await call('/chat', { ...chat, data: { text: 'Different' } })).status, 409);
  assert.equal(
    (await call('/media', { ...link, data: { ...source, title: 'Different' } })).status,
    409,
  );
  assert.equal(
    (await call('/upload', { form: video('different bytes'), key: uploadKey })).status,
    409,
  );

  const current = (await call('')).body;
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  assert.equal(current.receipts, undefined);
  assert.equal(current.messages.length, 1);
  assert.equal(current.queue.length, 2);
  assert.equal(saved.room.receipts.length, 3);
  assert.equal(saved.room.messages.length, 1);
  assert.equal(saved.room.queue.length, 2);
  assert.equal((await readdir(path.join(dir, 'uploads'))).length, 1);
});
