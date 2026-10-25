import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectSource, createSourceResolver } from '../src/server/sources.mjs';
import { parseSource, AppError } from '../src/server/validation.mjs';
import { createApplication } from '../src/server/app.mjs';
import { configuration } from '../src/server/config.mjs';
import { catalog, catalogUrl } from './fixtures/catalog.mjs';

test('source facade preserves existing media and reports compatibility without fetching', async () => {
  let calls = 0;
  const resolver = createSourceResolver(async () => {
    calls++;
    return structuredClone(catalog);
  });
  for (const [url, provider, mode] of [
    ['https://youtu.be/aqz-KE-bpKQ', 'youtube', 'embed'],
    ['https://twitch.tv/twitch', 'twitch', 'embed'],
    ['https://twitch.tv/videos/123', 'twitch', 'embed'],
    ['https://vimeo.com/123456/abcdef', 'vimeo', 'embed'],
    [catalog.options[0].url, 'kodik', 'embed'],
    [catalog.options[2].url, 'cvh', 'embed'],
    [catalog.options[4].url, 'alloha', 'manual'],
    ['https://media.example.org/movie.webm?token=abc', 'video', 'native'],
    ['https://media.example.org/movie.m3u8', 'hls', 'native'],
    ['<iframe src="https://youtu.be/aqz-KE-bpKQ" onload="alert(1)"></iframe>', 'youtube', 'embed'],
  ]) {
    const input = { url, title: 'My video' };
    const diagnostic = resolver.inspect(input);
    assert.equal(diagnostic.provider, provider);
    assert.equal(diagnostic.playbackMode, mode);
    assert.equal(diagnostic.supported, true);
    assert.equal(diagnostic.title, 'My video');
    assert.ok(diagnostic.reason);
    assert.match(diagnostic.sourceUrl, /^https:\/\//);
    assert.equal(diagnostic.sourceUrl.includes('<iframe'), false);
    assert.deepEqual((await resolver.resolve(input)).media, parseSource(input));
  }
  assert.equal(resolver.inspect({ url: catalogUrl }).playbackMode, 'catalog');
  assert.equal(calls, 0);
  const resolved = await resolver.resolve({ url: catalogUrl, title: 'Our series' });
  assert.equal(calls, 1);
  assert.equal(resolved.media.catalogTitle, 'Our series');
  assert.equal(resolved.description.variants.length, catalog.options.length);
  assert.equal(resolved.media.type, 'kodik');
});

test('unsafe or unsupported inputs cannot reach a network resolver or echo active HTML', async () => {
  let calls = 0;
  const resolver = createSourceResolver(async () => {
    calls++;
    throw new Error('Must not fetch');
  });
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'https://127.0.0.1/video.mp4',
    'https://[::1]/video.mp4',
    'https://2130706433/video.mp4',
    'https://localhost/video.mp4',
    'https://host.internal/video.mp4',
    'https://user:secret@example.org/video.mp4',
    'https://example.org:444/video.mp4',
    'https://old.yummyani.me.evil.org/catalog/item/test',
    'https://old.yummyani.me/api/profile',
    'https://example.org/film',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  ]) {
    const result = resolver.inspect({ url });
    assert.equal(result.supported, false, url);
    assert.equal(result.sourceUrl, null);
    assert.equal(result.playbackMode, 'unsupported');
    assert.equal(result.reason.includes('secret'), false);
    await assert.rejects(resolver.resolve({ url }), { status: 400 });
  }
  assert.equal(calls, 0);
  for (const input of [
    { url: 42 },
    { url: 'x'.repeat(8193) },
    { url: catalogUrl, extra: 'ignored?' },
  ])
    assert.throws(() => inspectSource(input));
  const failing = createSourceResolver(async () => {
    throw new AppError(504, 'YummyAnime не ответил.');
  });
  await assert.rejects(failing.resolve({ url: catalogUrl }), { status: 504 });
});

test('diagnostics require membership and Origin, are bounded and share catalog limits on both add routes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-sources-'));
  let calls = 0;
  const app = await createApplication(configuration({ DATA_DIR: dir }), {
    resolveCatalog: async () => {
      calls++;
      return structuredClone(catalog);
    },
  });
  try {
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = (url, data, cookie, origin = base) =>
      fetch(base + url, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(data),
      });
    const created = await post('/api/rooms', { name: 'Host', title: 'Diagnostics' });
    const cookie = created.headers.get('set-cookie').split(';')[0];
    const root = '/api/rooms/' + (await created.json()).id;
    const endpoint = root + '/source/inspect';
    assert.equal((await post(endpoint, { url: catalogUrl })).status, 401);
    assert.equal(
      (await post(endpoint, { url: catalogUrl }, cookie, 'https://evil.org')).status,
      403,
    );
    const inspected = await post(endpoint, { url: catalogUrl }, cookie);
    assert.equal(inspected.status, 200);
    assert.match(inspected.headers.get('cache-control'), /no-store/);
    assert.equal((await inspected.json()).provider, 'yummy');
    assert.equal(calls, 0);
    assert.equal((await post(endpoint, { url: 'x'.repeat(9000) }, cookie)).status, 413);
    let last;
    for (let i = 0; i < 30; i++)
      last = await post(endpoint, { url: 'https://example.org/page' }, cookie);
    assert.equal(last.status, 429);
    // Exhausting diagnosis does not prevent the ordinary add action.
    assert.equal(
      (await post(root + '/media', { url: 'https://youtu.be/aqz-KE-bpKQ' }, cookie)).status,
      201,
    );
    for (let i = 0; i < 10; i++)
      assert.equal((await post(root + '/media', { url: catalogUrl }, cookie)).status, 201);
    assert.equal((await post(root + '/catalog', { url: catalogUrl }, cookie)).status, 429);
    assert.equal(calls, 10);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
