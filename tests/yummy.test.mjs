import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveYummy, yummyPath, isPublicIPv4 } from '../src/server/yummy.mjs';
import { parseSource } from '../src/server/validation.mjs';

test('page resolver only accepts the fixed source and public IPv4 addresses', () => {
  for (const url of [
    'http://old.yummyani.me/catalog/item/test',
    'https://evil.org/catalog/item/test',
    'https://old.yummyani.me@127.0.0.1/catalog/item/test',
    'https://old.yummyani.me:444/catalog/item/test',
    'https://old.yummyani.me/api/profile',
    'https://old.yummyani.me/catalog/item/../../admin',
  ])
    assert.throws(() => yummyPath(url));
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.0.16',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '999.999.999.999',
  ])
    assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4('8.8.8.8'), true);
});

test('page discovery exposes translations and locks a Kodik season to the selected episode', async () => {
  const urls = [];
  const season =
    '//kodikplayer.com/season/123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/720p?episode=2&autoplay=true';
  const result = await resolveYummy('https://old.yummyani.me/catalog/item/example', async (url) => {
    urls.push(url);
    return url.startsWith('/catalog/')
      ? '<meta id="page_id" content="123"><h1>Example &amp; title</h1>'
      : JSON.stringify({
          response: [
            { data: { player: 'Kodik', dubbing: 'Voice A' }, number: '2', iframe_url: season },
            {
              data: { player: 'Other', dubbing: 'Voice B' },
              number: '3',
              iframe_url: 'https://evil.org/iframe',
            },
          ],
        });
  });
  assert.deepEqual(urls, ['/catalog/item/example', '/api/anime/123/videos']);
  assert.equal(result.title, 'Example & title');
  assert.equal(result.options[0].dubbing, 'Voice A');
  assert.equal(result.options[0].supported, true);
  assert.equal(result.options[1].supported, false);
  const url = new URL(result.options[0].url);
  assert.equal(url.searchParams.get('episode'), '2');
  assert.equal(url.searchParams.get('only_episode'), 'true');
  assert.equal(url.searchParams.has('autoplay'), false);
  assert.equal(parseSource({ url: url.href }).url, url.href);
  assert.throws(() => parseSource({ url: season.split('?')[0] }));
});
