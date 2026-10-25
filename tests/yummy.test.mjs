import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import {
  resolveYummy,
  yummyPath,
  isPublicIPv4,
  createYummyFetcher,
  createYummyResolver,
} from '../src/server/yummy.mjs';
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
    '192.88.99.1',
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
      ? '<meta id="page_id" content="123"><meta property="og:image" content="//static.yani.tv/posters/full/123.jpg"><h1>Example &amp; title</h1>'
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
  assert.equal(result.poster, 'https://static.yani.tv/posters/full/123.jpg');
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

test('Yummy HTTPS transport pins DNS, rejects rebinding and never follows redirects', async () => {
  const calls = [];
  const dnsLookup = async (host, options) => {
    calls.push(['dns', host, options]);
    return [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ];
  };
  const httpsRequest = (options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      calls.push(['request', options]);
      const res = new PassThrough();
      res.statusCode = 302;
      req.response = res;
      callback(res);
    };
    req.destroy = (error) => {
      req.emit('error', error);
      req.emit('close');
      req.response?.destroy();
    };
    return req;
  };
  const fetch = createYummyFetcher({ dnsLookup, httpsRequest, responseTimeoutMs: 100 });
  await assert.rejects(fetch('/catalog/item/episode'), { status: 502 });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['dns', 'request'],
  );
  const options = calls[1][1];
  assert.equal(options.hostname, 'old.yummyani.me');
  assert.equal(options.path, '/catalog/item/episode');
  assert.equal(options.method, 'GET');
  assert.equal(
    options.lookup('old.yummyani.me', { all: true }, (error, answer) => {
      assert.ifError(error);
      assert.equal(answer[0].address, '8.8.8.8');
    }),
    undefined,
  );
  options.lookup('old.yummyani.me', {}, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
  await assert.rejects(fetch('/catalog/item/../../secret'), { status: 400 });
  const rebound = createYummyFetcher({
    dnsLookup: async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }],
    httpsRequest: () => {
      throw new Error('HTTPS must not be opened');
    },
  });
  await assert.rejects(rebound('/catalog/item/rebind'), { status: 502 });
});

test('Yummy transport bounds DNS/connect time, response bytes and accepted status', async () => {
  const neverLookup = () => new Promise(() => {});
  await assert.rejects(
    createYummyFetcher({ dnsLookup: neverLookup, dnsTimeoutMs: 10 })('/catalog/item/timeout-dns'),
    { status: 504 },
  );
  const stalled = createYummyFetcher({
    dnsLookup: async () => [{ address: '8.8.8.8' }],
    responseTimeoutMs: 10,
    httpsRequest: (_options, _callback) => {
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = (error) => {
        req.emit('error', error);
        req.emit('close');
      };
      return req;
    },
  });
  await assert.rejects(stalled('/catalog/item/timeout-body'), { status: 504 });
  const requestWithResponse = (status, body) => (options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = new PassThrough();
      res.statusCode = status;
      req.response = res;
      callback(res);
      process.nextTick(() => res.end(body));
    };
    req.destroy = (error) => {
      req.emit('error', error);
      req.emit('close');
      req.response?.destroy();
    };
    return req;
  };
  const huge = createYummyFetcher({
    dnsLookup: async () => [{ address: '8.8.8.8' }],
    httpsRequest: requestWithResponse(200, 'too large'),
    maxResponseBytes: 4,
  });
  await assert.rejects(huge('/catalog/item/huge'), { status: 502 });
  const redirect = createYummyFetcher({
    dnsLookup: async () => [{ address: '8.8.8.8' }],
    httpsRequest: requestWithResponse(307, 'ignored'),
  });
  await assert.rejects(redirect('/catalog/item/redirect'), { status: 502 });
  const valid = createYummyFetcher({
    dnsLookup: async () => [{ address: '8.8.8.8' }],
    httpsRequest: requestWithResponse(200, 'bounded'),
  });
  assert.equal(await valid('/api/anime/123/videos'), 'bounded');
});

test('Yummy resolver caps concurrent page reads and keeps a bounded twenty-page cache', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let active = 0,
    maximum = 0,
    calls = 0;
  const resolver = createYummyResolver(async (url) => {
    active++;
    maximum = Math.max(active, maximum);
    calls++;
    await gate;
    active--;
    return { title: url, options: [] };
  });
  const url = (i) => `https://old.yummyani.me/catalog/item/episode-${i}`;
  const pending = [0, 1, 2].map((i) => resolver(url(i)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 3);
  await assert.rejects(resolver(url(3)), { status: 429 });
  release();
  await Promise.all(pending);
  assert.equal(calls, 3);
  await resolver(url(0));
  assert.equal(calls, 3, 'a cached page is not resolved again');
  for (let i = 3; i < 21; i++) await resolver(url(i));
  assert.equal(calls, 21);
  await resolver(url(0));
  assert.equal(calls, 22, 'the oldest inserted page is evicted after twenty unique entries');
});
