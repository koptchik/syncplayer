import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPageDiscovery, discoveryHosts, examplePage } from '../src/server/page-discovery.mjs';
import { createFixedHostFetcher } from '../src/server/fixed-fetch.mjs';
import { configuration } from '../src/server/config.mjs';
import { createApplication } from './helpers/application.mjs';

test('static discovery extracts playable candidates and deduplicates their canonical addresses', async () => {
  const discover = createPageDiscovery(new Set(['media.example.org']), async (host, pathname) => {
    assert.equal(host, 'media.example.org');
    assert.equal(pathname, '/shows/film.html');
    return `<title>Тестовый фильм</title>
      <base href="https://outside.example.org/">
      <meta property="og:video" content="movie.webm#start">
      <video src="movie.webm"><source src="movie.mp4">
        <source src="https://outside.example.org/movie.webm">
        <source src="preview.mp4?signature=private">
        <source src="blob:temporary">
      </video>
      <audio><source src="audio.mp4"></audio>
      <script type="application/ld+json">{"@graph":[{"@type":"VideoObject","contentUrl":"/play/movie.m3u8"}]}</script>
      <video src="/play/movie.mpd"></video>
      <iframe src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"></iframe>
      <iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ"></iframe>
      <iframe src="https://rutube.ru/play/embed/df566fac28e4853bbf4e6389a6d08cda/" srcdoc="ignored"></iframe>
      <iframe src="https://vimeo.com/12345678/a1b2c3d4"></iframe>
      <iframe src="https://outside.example.org/player"></iframe>`;
  });
  const result = await discover({ url: 'https://media.example.org/shows/film.html' });
  assert.equal(result.title, 'Тестовый фильм');
  assert.equal(result.hasDash, true);
  assert.deepEqual(result.candidates, [
    { url: 'https://media.example.org/shows/movie.webm', format: 'webm', provider: 'video' },
    { url: 'https://media.example.org/shows/movie.mp4', format: 'mp4', provider: 'video' },
    { url: 'https://media.example.org/play/movie.m3u8', format: 'm3u8', provider: 'video' },
    {
      url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
      format: 'embed',
      provider: 'youtube',
    },
  ]);
});

test('only configured HTTPS pages and the exact demo reach the bounded transport', async () => {
  const hosts = discoveryHosts('Media.Example.org');
  const requests = [];
  const discover = createPageDiscovery(hosts, async (...args) => {
    requests.push(args);
    return '<video src="clip.mp4">';
  });
  for (const url of [
    'http://media.example.org/film',
    'https://media.example.org/film?token=private',
    'https://media.example.org:8443/film',
    'https://name@media.example.org/film',
    'https://media.example.org/film.mp4',
  ]) {
    await assert.rejects(discover({ url }), { status: 400 });
  }
  for (const url of [
    'https://other.media.example.org/film',
    'https://127.0.0.1/film',
    'https://mdn.github.io/other-page.html',
  ]) {
    await assert.rejects(discover({ url }), { status: 422 });
  }
  assert.equal(requests.length, 0);
  await discover({ url: examplePage });
  assert.deepEqual(requests, [['mdn.github.io', new URL(examplePage).pathname]]);
  assert.throws(() => discoveryHosts('*.example.org'));
});

test('page discovery requires a room session and the room Origin', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-page-'));
  let calls = 0;
  const app = await createApplication(configuration({ DATA_DIR: dir }), {
    discoverPage: createPageDiscovery(new Set(), async () => {
      calls++;
      return '<video src="clip.mp4">';
    }),
  });
  try {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const post = (endpoint, body, headers = {}) =>
      fetch(origin + endpoint, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const created = await post('/api/rooms', { name: 'Host', title: 'Movie night' });
    const cookie = created.headers.get('set-cookie').split(';')[0];
    const endpoint = `/api/rooms/${(await created.json()).id}/source/discover`;
    assert.equal((await post(endpoint, { url: examplePage })).status, 401);
    assert.equal(
      (
        await post(
          endpoint,
          { url: examplePage },
          { Cookie: cookie, Origin: 'https://other.example.org' },
        )
      ).status,
      403,
    );
    assert.equal(calls, 0);
    const result = await post(endpoint, { url: examplePage }, { Cookie: cookie });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).candidates.length, 1);
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('discovery transport closes responses before reading non-HTML bodies', async () => {
  const read = createFixedHostFetcher({
    hostname: 'media.example.org',
    allowedPath: /^\/film$/,
    label: 'Test',
    dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
    verifyContentType: /^text\/html/,
    httpsRequest(options, respond) {
      assert.equal(options.agent, false);
      const req = new EventEmitter();
      req.end = () => respond({ statusCode: 200, headers: { 'content-type': 'video/mp4' } });
      req.destroy = (error) => {
        req.emit('error', error);
        req.emit('close');
      };
      return req;
    },
  });
  await assert.rejects(read('/film'), { status: 415 });
});
