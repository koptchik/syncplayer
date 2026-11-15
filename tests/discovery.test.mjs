import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseSource } from '../src/server/validation.mjs';
import { createMetadataResolver } from '../src/server/metadata.mjs';
import { parseSearchResults, createSearchService } from '../src/server/search.mjs';
import { safeArtwork } from '../public/artwork.js';
import { createApplication } from './helpers/application.mjs';
import { configuration } from '../src/server/config.mjs';
const id = 'df566fac28e4853bbf4e6389a6d08cda',
  url = `https://rutube.ru/video/${id}/?r=wd`;
test('Rutube links and iframe codes canonicalize identically; spoofed or invalid inputs are rejected', () => {
  const parsed = parseSource({ url });
  assert.equal(parsed.type, 'rutube');
  assert.equal(parsed.url, `https://rutube.ru/play/embed/${id}/`);
  assert.deepEqual(
    parseSource({
      url: `<iframe src="https://rutube.ru/play/embed/${id}/" onload="alert(1)"></iframe>`,
    }),
    parsed,
  );
  for (const link of [
    url.replace('rutube.ru', 'rutube.ru.evil.org'),
    url.replace('https:', 'http:'),
    url.replace(id, 'invalid'),
    url.replace('rutube.ru', 'rutube.ru:444'),
    url.replace('rutube.ru', 'user:pass@rutube.ru'),
    'https://rutube.ru/video/',
  ])
    assert.throws(() => parseSource({ url: link }));
});
test('metadata preserve custom names, reject untrusted images, cache and fall back without losing playable media', async () => {
  let count = 0;
  const enrich = createMetadataResolver(async (type, path) => {
    count++;
    assert.equal(type, 'rutube');
    assert.equal(path, `/api/video/${id}/?format=json`);
    return { title: 'Movie name', thumbnail_url: 'https://pic.rtbcdn.ru/video/poster.jpg' };
  });
  const media = parseSource({ url });
  assert.equal((await enrich(media)).title, 'Movie name');
  assert.equal(
    (await enrich({ ...media, title: 'Custom' }, { preserveTitle: true })).title,
    'Custom',
  );
  assert.equal(count, 1);
  for (const image of [
    'http://pic.rtbcdn.ru/a.jpg',
    'https://pic.rtbcdn.ru.evil.org/a.jpg',
    'https://user:pass@pic.rtbcdn.ru/a.jpg',
    'https://127.0.0.1/a.jpg',
  ])
    assert.equal(safeArtwork(image), null);
  assert.deepEqual(
    await createMetadataResolver(async () => {
      throw new Error('Network unavailable');
    })(media),
    media,
  );
  const bad = await createMetadataResolver(async () => ({
    title: 'Good',
    thumbnail_url: 'https://evil.org/private',
  }))(media);
  assert.equal(bad.poster, undefined);
});
test('provider search reconstructs allowed URLs, deduplicates, bounds results and returns partial failures', async () => {
  const entries = [
    { id, title: 'A', thumbnail_url: 'https://pic.rtbcdn.ru/video/a.jpg' },
    { id, title: 'Duplicate' },
    { id: '../../../private', title: 'Bad' },
  ];
  assert.equal(parseSearchResults('rutube', JSON.stringify({ results: entries })).length, 1);
  const anime = parseSearchResults(
    'yummy',
    JSON.stringify({
      response: [
        {
          anime_url: 'naruto-tv-1',
          title: 'Naruto',
          poster: { small: '//static.yani.tv/posters/a.jpg' },
          year: 2002,
        },
        { anime_url: '../../private', title: 'Bad' },
      ],
    }),
  );
  assert.equal(anime[0].url, 'https://old.yummyani.me/catalog/item/naruto-tv-1');
  assert.equal(anime.length, 1);
  const films = parseSearchResults(
    'lordfilm',
    '<a class="item__title" href="https://8.lordfilms.mobile/1773/">Film</a><a class="item__title" href="http://127.0.0.1/1773/">Bad</a>',
  );
  assert.equal(films.length, 1);
  let calls = 0;
  const search = createSearchService(async (provider, pathname) => {
    calls++;
    assert.equal(pathname.includes('http://'), false);
    if (provider !== 'rutube') throw new Error('Offline');
    return JSON.stringify({ results: entries });
  });
  const result = await search({ query: 'A & movie' });
  assert.equal(result.results.length, 1);
  assert.equal(result.sources.filter((s) => !s.available).length, 2);
  await search({ query: 'A & movie' });
  assert.equal(calls, 3);
  for (const query of ['x', 'x'.repeat(101), 'movie\nhttp://127.0.0.1'])
    await assert.rejects(search({ query }));
  await assert.rejects(search({ query: 'movie', providers: ['evil'] }));
});
test('discovery APIs enforce session/Origin and enrich additions while keeping scoped metadata', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-discovery-'));
  let searches = 0;
  const app = await createApplication(configuration({ DATA_DIR: dir }), {
    enrichMedia: createMetadataResolver(async () => ({
      title: 'Server title',
      thumbnail_url: 'https://pic.rtbcdn.ru/video/poster.jpg',
    })),
    searchSources: async () => {
      searches++;
      return { results: [], sources: [] };
    },
  });
  try {
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = (target, data, cookie, origin = base) =>
      fetch(base + target, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(data),
      });
    const made = await post('/api/rooms', { name: 'Host', title: 'Search' }),
      cookie = made.headers.get('set-cookie').split(';')[0],
      root = '/api/rooms/' + (await made.json()).id;
    assert.equal((await post(root + '/source/search', { query: 'movie' })).status, 401);
    assert.equal(
      (await post(root + '/source/search', { query: 'movie' }, cookie, 'https://evil.org')).status,
      403,
    );
    assert.equal(searches, 0);
    const media = await post(root + '/media', { url }, cookie);
    assert.equal(media.status, 201);
    assert.equal((await media.json()).title, 'Server title');
    const custom = await post(root + '/media', { url, title: 'My title' }, cookie);
    assert.equal((await custom.json()).title, 'My title');
    let last;
    for (let i = 0; i < 11; i++)
      last = await post(root + '/source/search', { query: 'movie' }, cookie);
    assert.equal(last.status, 429);
    assert.equal(searches, 10);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
