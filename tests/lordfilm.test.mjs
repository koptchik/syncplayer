import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lordfilmPath, resolveLordfilm, createLordfilmResolver } from '../src/server/lordfilm.mjs';
import { createSourceResolver } from '../src/server/sources.mjs';
const pageUrl = 'https://8.lordfilms.mobile/1773/';
test('LordFilm only fetches the fixed numeric page and parses bounded CVH identifiers without executing site code', async () => {
  for (const url of [
    'http://8.lordfilms.mobile/1773/',
    'https://8.lordfilms.mobile.evil.org/1773/',
    'https://8.lordfilms.mobile@127.0.0.1/1773/',
    'https://8.lordfilms.mobile:444/1773/',
    'https://8.lordfilms.mobile/1773/?url=http://127.0.0.1',
    'https://8.lordfilms.mobile/../../../admin',
  ])
    assert.throws(() => lordfilmPath(url));
  let seen;
  const movie = await resolveLordfilm(pageUrl, async (path) => {
    seen = path;
    return '<h1>Test &amp; movie</h1><video-player data-title-id="602749" data-publisher-id="2253" data-aggregator="kp"></video-player><script>throw new Error("Not executed")</script><iframe src="http://127.0.0.1/admin"></iframe>';
  });
  assert.equal(seen, '/1773/');
  assert.deepEqual(movie.config, { titleId: '602749', publisherId: '2253' });
  assert.equal(movie.title, 'Test & movie');
  await assert.rejects(
    resolveLordfilm(pageUrl, async () => '<iframe src="https://evil.org"></iframe>'),
    { status: 422 },
  );
  const facade = createSourceResolver(
    async () => {
      throw new Error('Wrong adapter');
    },
    async () => movie,
  );
  assert.equal(facade.inspect({ url: pageUrl }).provider, 'lordfilm');
  assert.equal((await facade.resolve({ url: pageUrl, title: 'Custom' })).media.title, 'Custom');
  assert.equal((await facade.resolve({ url: pageUrl })).media.title, 'Test & movie');
  let count = 0;
  const resolve = createLordfilmResolver(async () => {
    count++;
    return movie;
  });
  await resolve(pageUrl);
  await resolve(pageUrl);
  assert.equal(count, 1);
});
