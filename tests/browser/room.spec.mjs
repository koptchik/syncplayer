import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogUrl } from '../fixtures/catalog.mjs';

async function createRoom(page, name = 'Аня') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать комнату', exact: true }).click();
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByLabel('Название комнаты').fill('Наш киносеанс');
  await page.locator('#roomSubmit').click();
  await expect(page).toHaveURL(/\/room\/[a-f0-9]{32}$/);
  await expect(page.locator('#connectionStatus')).toContainText('Вы в комнате');
}
async function joinRoom(page, url, name = 'Миша') {
  await page.goto(url);
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти в комнату', exact: true }).click();
  await expect(page.locator('#connectionStatus')).toContainText('Вы в комнате');
}

test('desktop and mobile landing pages are usable and do not overflow', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'На одной волне' })).toBeVisible();
  await page.screenshot({ path: 'test-results/landing-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#inviteButton')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/landing-mobile.png', fullPage: true });
  await page.locator('#inviteButton').click();
  await expect(page.getByLabel('Ваше имя')).toBeVisible();
  expect(errors).toEqual([]);
});

test('two users upload, watch, seek, pause, chat safely, reconnect and delete media', async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const errors = [];
  host.on('pageerror', (error) => errors.push(error.message));
  guest.on('pageerror', (error) => errors.push(error.message));
  try {
    await createRoom(host);
    await host.locator('#inviteButton').click();
    await expect(host.locator('#inviteUrl')).toHaveValue(
      `https://stream.koptchik.duckdns.org${new URL(host.url()).pathname}`,
    );
    await expect(host.locator('#inviteHint')).not.toContainText('localhost');
    await host.locator('[data-close="inviteDialog"]').click();
    await joinRoom(guest, host.url());
    await expect(host.locator('#peopleCount')).toHaveText('2');
    await guest.locator('#chatInput').fill('<img src=x onerror="window.xss=true"> Привет!');
    await guest.getByRole('button', { name: 'Отправить сообщение' }).click();
    await expect(host.locator('#messages')).toContainText(
      '<img src=x onerror="window.xss=true"> Привет!',
    );
    expect(await host.evaluate(() => Boolean(window.xss))).toBe(false);
    await expect(host.locator('#messages img')).toHaveCount(0);
    await guest.locator('#addButton').click();
    await guest.locator('#fileInput').setInputFiles(path.resolve('tests/fixtures/sample.webm'));
    await guest.locator('#mediaSubmit').click();
    await expect(guest.locator('#addDialog')).not.toBeVisible();
    await expect(host.locator('#queueCount')).toHaveText('1');
    await expect(guest.locator('#queueCount')).toHaveText('1');
    await expect
      .poll(() => host.locator('video').evaluate((video) => video.readyState))
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => guest.locator('video').evaluate((video) => video.readyState))
      .toBeGreaterThanOrEqual(2);
    await host.locator('video').evaluate((video) => video.play());
    await expect.poll(() => guest.locator('video').evaluate((video) => !video.paused)).toBe(true);
    await guest.locator('video').evaluate((video) => {
      video.currentTime = 8;
    });
    await expect
      .poll(() => host.locator('video').evaluate((video) => video.currentTime))
      .toBeGreaterThan(7);
    await guest.locator('video').evaluate((video) => video.pause());
    await expect.poll(() => host.locator('video').evaluate((video) => video.paused)).toBe(true);
    // Wait past a checkpoint to catch a previous controller accidentally restarting playback.
    await host.waitForTimeout(3200);
    expect(await host.locator('video').evaluate((video) => video.paused)).toBe(true);
    expect(await guest.locator('video').evaluate((video) => video.paused)).toBe(true);
    const hostPosition = await host.locator('video').evaluate((video) => video.currentTime);
    const guestPosition = await guest.locator('video').evaluate((video) => video.currentTime);
    expect(Math.abs(hostPosition - guestPosition)).toBeLessThan(1.5);
    await guest.locator('video').evaluate((video) => {
      video.playbackRate = 1.5;
    });
    await expect
      .poll(() => host.locator('video').evaluate((video) => video.playbackRate))
      .toBe(1.5);
    await guest.locator('video').evaluate((video) => video.play());
    await expect.poll(() => host.locator('video').evaluate((video) => !video.paused)).toBe(true);
    // The original host can immediately take control back from a participant.
    await host.locator('video').evaluate((video) => video.pause());
    await expect.poll(() => guest.locator('video').evaluate((video) => video.paused)).toBe(true);
    await guest.locator('#queueList .queue-play').click();
    await expect
      .poll(() => host.locator('video').evaluate((video) => video.currentTime))
      .toBeLessThan(1);
    await guest.locator('video').evaluate((video) => {
      video.currentTime = 8;
    });
    await expect
      .poll(() => host.locator('video').evaluate((video) => video.currentTime))
      .toBeGreaterThan(7);
    // Selecting the current item must also reset the selecting participant's own player.
    await guest.locator('#queueList .queue-play').click();
    await expect
      .poll(() => guest.locator('video').evaluate((video) => video.currentTime))
      .toBeLessThan(1);
    await expect
      .poll(() => host.locator('video').evaluate((video) => video.currentTime))
      .toBeLessThan(1);
    await guest.locator('video').evaluate((video) => {
      video.currentTime = 8;
    });
    await expect
      .poll(() => host.locator('video').evaluate((video) => video.currentTime))
      .toBeGreaterThan(7);
    await guest.reload();
    await expect(guest.locator('#connectionStatus')).toContainText('Вы в комнате');
    await expect(guest.locator('#messages')).toContainText('Привет!');
    await expect
      .poll(() => guest.locator('video').evaluate((video) => video.currentTime))
      .toBeGreaterThan(7);
    await host.reload();
    await expect(host.locator('#syncStatus')).toHaveText('Управляют все участники');
    await expect(host.locator('#queueCount')).toHaveText('1');
    await host.screenshot({ path: 'test-results/room-desktop.png', fullPage: true });
    await host.getByRole('button', { name: 'Убрать: sample.webm' }).click();
    await expect(guest.locator('#queueCount')).toHaveText('0');
    await expect(guest.getByRole('heading', { name: 'На одной волне' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('short paused seeks propagate in both directions without echoing back', async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await createRoom(host);
    await joinRoom(guest, host.url());
    await host.locator('#addButton').click();
    await host.locator('#fileInput').setInputFiles(path.resolve('tests/fixtures/sample.webm'));
    await host.locator('#mediaSubmit').click();
    const hostVideo = host.locator('#mediaMount video');
    const guestVideo = guest.locator('#mediaMount video');
    for (const video of [hostVideo, guestVideo]) {
      await expect.poll(() => video.evaluate((el) => el.readyState)).toBeGreaterThan(1);
    }
    const seek = async (from, to, position) => {
      await from.evaluate((el, target) => {
        el.currentTime = target;
      }, position);
      await expect
        .poll(() => to.evaluate((el) => ({ position: el.currentTime, paused: el.paused })))
        .toEqual({ position, paused: true });
    };
    await seek(hostVideo, guestVideo, 5);
    await seek(guestVideo, hostVideo, 5.5);
    await seek(hostVideo, guestVideo, 5.25);
    const roomPath = new URL(host.url()).pathname.replace('/room/', '/api/rooms/');
    const snapshot = await (await host.request.get(roomPath)).json();
    expect(snapshot.controllerId).toBe(snapshot.me.id);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('retrying a chat submission after a lost response adds one message', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await createRoom(host);
    await joinRoom(guest, host.url());
    const keys = [];
    await host.route('**/api/rooms/*/chat', async (route) => {
      keys.push(route.request().headers()['idempotency-key']);
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      if (keys.length === 1) await route.abort();
      else await route.fulfill({ response });
    });
    const input = host.locator('#chatInput');
    const send = host.getByRole('button', { name: 'Отправить сообщение' });
    const message = 'Сообщение после обрыва ответа';
    await input.fill(message);
    await send.click();
    await expect(host.locator('#toast')).toBeVisible();
    await expect(guest.getByText(message, { exact: true })).toHaveCount(1);
    await expect(input).toHaveValue(message);
    await send.click();
    await expect(input).toHaveValue('');
    await expect(guest.getByText(message, { exact: true })).toHaveCount(1);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(keys[1]).toBe(keys[0]);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('invalid links show a useful error; YouTube and Twitch queue items are parsed', async ({
  page,
}) => {
  // Keep this test deterministic: provider availability is outside the app's control.
  await page.route('https://www.youtube.com/iframe_api', (route) => route.abort());
  await page.route('https://player.twitch.tv/js/embed/v1.js', (route) => route.abort());
  await createRoom(page, 'Саша');
  await page.locator('[data-source="youtube"]').click();
  await page.locator('#urlInput').fill('https://evil.example/video');
  await page.locator('#mediaSubmit').click();
  await expect(page.locator('#uploadStatus')).toContainText('YouTube');
  await page.locator('#urlInput').fill('https://youtu.be/aqz-KE-bpKQ');
  await page.locator('#mediaTitleInput').fill('Вечерний фильм');
  await page.locator('#mediaSubmit').click();
  await expect(page.locator('#queueCount')).toHaveText('1');
  await expect(page.locator('#queueList')).toContainText('Вечерний фильм');
  await page.locator('[data-source="twitch"]').click();
  await page.locator('#urlInput').fill('https://twitch.tv/twitch');
  await page.locator('#mediaSubmit').click();
  await expect(page.locator('#queueCount')).toHaveText('2');
  await expect(page.locator('#queueList')).toContainText('Twitch · twitch');
  await page.locator('#queueList .queue-play').last().click();
  await expect(page.locator('#playerNotice')).toContainText('Не удалось подключить');
});

test('expired invitation offers a new room instead of a dead-end join form', async ({ page }) => {
  const expired = `/room/${'0'.repeat(32)}`;
  await page.goto(expired);
  await expect(page.locator('#roomDialogTitle')).toHaveText('Создать комнату');
  await expect(page.locator('#roomDialogDescription')).toContainText('после перезапуска');
  await page.locator('[data-close="roomDialog"]').click();
  await page.locator('#inviteButton').click();
  await expect(page.locator('#roomDialogTitle')).toHaveText('Создать комнату');
  await page.getByLabel('Ваше имя').fill('Новый вечер');
  await page.locator('#roomSubmit').click();
  await expect(page.locator('#connectionStatus')).toContainText('Вы в комнате');
  expect(new URL(page.url()).pathname).not.toBe(expired);
  await page.locator('#inviteButton').click();
  await expect(page.locator('#inviteUrl')).toHaveValue(
    `https://stream.koptchik.duckdns.org${new URL(page.url()).pathname}`,
  );
});

test('a room disappearing during join switches the form to creation and preserves the name', async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await createRoom(host);
    await guest.goto(host.url());
    await expect(guest.locator('#roomDialogTitle')).toHaveText('Присоединиться к вечеру');
    await guest.locator('#nameInput').fill('Сохрани моё имя');
    await guest.route('**/api/rooms/*/join', (route) =>
      route.fulfill({
        status: 404,
        json: { error: 'Комната не найдена или срок её действия истёк.' },
      }),
    );
    await guest.locator('#roomSubmit').click();
    await expect(guest.locator('#roomDialogTitle')).toHaveText('Создать комнату');
    await expect(guest.locator('#nameInput')).toHaveValue('Сохрани моё имя');
    await guest.locator('#roomSubmit').click();
    await expect(guest.locator('#connectionStatus')).toContainText('Вы в комнате');
    expect(guest.url()).not.toBe(host.url());
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('viewport layout keeps chat input accessible and scrolls the queue independently', async ({
  page,
}) => {
  await page.route('https://media.example.org/sample.webm', (route) =>
    route.fulfill({
      path: path.resolve('tests/fixtures/sample.webm'),
      contentType: 'video/webm',
    }),
  );
  await createRoom(page);
  const roomPath = new URL(page.url()).pathname.replace('/room/', '/api/rooms/');
  for (let i = 0; i < 12; i++) {
    const response = await page.request.post(`${roomPath}/media`, {
      headers: { origin: new URL(page.url()).origin },
      data: { url: 'https://media.example.org/sample.webm', title: `Видео ${i + 1}` },
    });
    expect(response.status()).toBe(201);
  }
  await expect(page.locator('#queueCount')).toHaveText('12');
  await expect
    .poll(() => page.locator('video').evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  for (const size of [
    { width: 1920, height: 960 },
    { width: 1366, height: 680 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.locator('#addButton')).toBeInViewport();
    expect(
      await page.locator('#queueList').evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    await page.locator('#queueList').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    if (size.width <= 850) await page.locator('[data-panel="chat"]').click();
    await expect(page.locator('#chatInput')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeInViewport();
    await page.locator('#chatInput').fill(`Экран ${size.width}`);
    await page.locator('#chatForm button').click();
    await expect(page.locator('#messages')).toContainText(`Экран ${size.width}`);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/viewport-${size.width}.png` });
    if (size.width <= 850) await page.locator('[data-panel="watch"]').click();
  }
});

test('HLS library is served locally and inaccessible streams show an actionable error', async ({
  page,
}) => {
  await page.route('https://media.example.org/unavailable.m3u8', (route) =>
    route.fulfill({
      status: 403,
      headers: { 'access-control-allow-origin': '*' },
      body: 'Forbidden',
    }),
  );
  await createRoom(page);
  await page.locator('[data-source="link"]').click();
  await page.locator('#urlInput').fill('https://media.example.org/unavailable.m3u8');
  await page.locator('#mediaSubmit').click();
  await expect(page.locator('#queueCount')).toHaveText('1');
  await expect(page.locator('#playerNotice')).toContainText('HLS-поток недоступен', {
    timeout: 20000,
  });
  await expect(page.locator('#queueList')).toContainText('HLS');
});

test('direct HLS video plays and can seek without contacting an external service', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://media.example.org/hls/**', (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({
      path: path.resolve('tests/fixtures/hls', file),
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await createRoom(page);
  await page.locator('[data-source="link"]').click();
  await page.locator('#urlInput').fill('https://media.example.org/hls/video.m3u8');
  await page.locator('#mediaSubmit').click();
  await expect
    .poll(() => page.locator('video').evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.locator('video').evaluate((v) => v.play());
  await expect
    .poll(() => page.locator('video').evaluate((v) => v.currentTime))
    .toBeGreaterThan(0.5);
  await page.locator('video').evaluate((v) => {
    v.currentTime = 10;
  });
  await expect
    .poll(() => page.locator('video').evaluate((v) => v.currentTime))
    .toBeGreaterThanOrEqual(10);
  await expect(page.locator('#playerNotice')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('Kodik iframe imports safely and synchronizes play, pause and seek across members', async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  for (const context of [hostContext, guestContext]) {
    await context.route('https://kodikplayer.com/**', (route) =>
      route.fulfill({ path: path.resolve('tests/fixtures/kodik.html'), contentType: 'text/html' }),
    );
  }
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await createRoom(host);
    await joinRoom(guest, host.url());
    await guest.locator('[data-source="link"]').click();
    await guest
      .locator('#urlInput')
      .fill(
        '<iframe src="https://kodikplayer.com/seria/1674048/a14f588b93b4bdf705efa9e6f1e81d14/720p" onload="window.xss=true" width="607" height="360"></iframe><script>window.xss=true</script>',
      );
    await guest.locator('#mediaSubmit').click();
    await expect(host.locator('#queueList')).toContainText('Kodik');
    await expect(host.frameLocator('#mediaMount iframe').locator('#play')).toBeVisible();
    await expect(guest.frameLocator('#mediaMount iframe').locator('#play')).toBeVisible();
    const frame = (page) =>
      page.frames().find((f) => f.url().startsWith('https://kodikplayer.com/'));
    expect(await host.evaluate(() => Boolean(window.xss))).toBe(false);
    expect(await guest.evaluate(() => Boolean(window.xss))).toBe(false);
    await guest.frameLocator('#mediaMount iframe').locator('#play').click();
    await expect.poll(() => frame(host).evaluate(() => window.snapshot().playing)).toBe(true);
    await guest.frameLocator('#mediaMount iframe').locator('#seek').click();
    await expect
      .poll(() => frame(host).evaluate(() => window.snapshot().time))
      .toBeGreaterThanOrEqual(39);
    await host.frameLocator('#mediaMount iframe').locator('#pause').click();
    await expect.poll(() => frame(guest).evaluate(() => window.snapshot().playing)).toBe(false);
    // An unrelated window cannot impersonate the embedded player.
    await host.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://kodikplayer.com',
          source: window,
          data: { key: 'kodik_player_play' },
        }),
      ),
    );
    await host.waitForTimeout(3300);
    expect(await frame(guest).evaluate(() => window.snapshot().playing)).toBe(false);
    expect(await frame(host).evaluate(() => window.snapshot().playing)).toBe(false);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test('a host pins the room and leaves; the guest becomes host and can rejoin with the same invitation', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const host = await a.newPage(),
      guest = await b.newPage();
    await createRoom(host);
    const url = host.url();
    await joinRoom(guest, url);
    await expect(guest.locator('#permanentButton')).not.toBeVisible();
    await host.locator('#permanentButton').click();
    await host.locator('#ownerPassword').fill('test room owner password');
    await host.locator('#ownerSubmit').click();
    await expect(host.locator('#roomBadge')).toHaveText('ПОСТОЯННАЯ КОМНАТА');
    await host.locator('#leaveButton').click();
    await expect(host).toHaveURL(/\/$/);
    await expect(guest.locator('#peopleCount')).toHaveText('1');
    await guest.locator('#profileButton').click();
    await expect(guest.locator('#toast')).toContainText('ведущий');
    await guest.locator('#leaveButton').click();
    await expect(guest).toHaveURL(/\/$/);
    await host.locator('#returnRoomButton').click();
    await expect(host).toHaveURL(url);
    await host.locator('#nameInput').fill('Снова дома');
    await host.locator('#roomSubmit').click();
    await expect(host.locator('#roomBadge')).toHaveText('ПОСТОЯННАЯ КОМНАТА');
    await host.locator('#profileButton').click();
    await expect(host.locator('#toast')).toContainText('ведущий');

    // The original owner closes the room from the invitation in a fresh browser session.
    await guest.goto(url);
    await guest.locator('#invitedOwnerButton').click();
    await guest.locator('#ownerName').fill('Аня');
    await guest.locator('#ownerPassword').fill('test room owner password');
    await guest.locator('#ownerSubmit').click();
    await expect(guest).toHaveURL(/\/$/);
    await expect(host.locator('#roomBadge')).toHaveText('КОМНАТА ЗАКРЫТА');
    await host.reload();
    await expect(host.locator('#roomDialogTitle')).toHaveText('Создать комнату');
  } finally {
    await a.close();
    await b.close();
  }
});

test('catalog choices change during viewing for everyone; CVH controls and compact layout work', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const errors = [];
  for (const context of [a, b]) {
    await context.route('https://kodikplayer.com/**', (route) =>
      route.fulfill({ path: path.resolve('tests/fixtures/kodik.html'), contentType: 'text/html' }),
    );
    await context.route('https://ru.yummyani.me/**', (route) =>
      route.fulfill({ path: path.resolve('tests/fixtures/cvh.html'), contentType: 'text/html' }),
    );
    await context.route('https://alloha.yani.tv/**', (route) =>
      route.fulfill({ status: 404, body: 'Unavailable', contentType: 'text/html' }),
    );
  }
  try {
    const host = await a.newPage(),
      guest = await b.newPage();
    for (const page of [host, guest]) page.on('pageerror', (error) => errors.push(error.message));
    await createRoom(host);
    await joinRoom(guest, host.url());
    await guest.locator('[data-source="link"]').click();
    await guest.locator('#urlInput').fill(catalogUrl);
    await guest.locator('#mediaTitleInput').fill('Наш сериал');
    await guest.locator('#mediaSubmit').click();
    await expect(guest.locator('#addDialog')).not.toBeVisible();
    await expect(host.locator('#watchPlayer')).toHaveValue('Kodik');
    await expect(guest.locator('#watchDubbing')).toHaveValue('Voice A');
    const apiPath = new URL(host.url()).pathname.replace('/room/', '/api/rooms/');
    const state = async () => (await host.request.get(apiPath)).json();
    const initial = await state();
    await host.request.post(`${apiPath}/control`, {
      headers: { origin: new URL(host.url()).origin },
      data: { mediaId: initial.queue[0].id, position: 32, playing: false, rate: 1 },
    });
    await guest.locator('#watchDubbing').selectOption('Voice B');
    await guest.locator('#applySource').click();
    await expect(host.locator('#watchDubbing')).toHaveValue('Voice B');
    await expect.poll(async () => (await state()).playback.position).toBe(32);
    await expect(host.locator('#queueList')).toContainText('Наш сериал');
    await guest.locator('#watchPlayer').selectOption('CVH');
    await guest.locator('#applySource').click();
    await expect(host.locator('#watchPlayer')).toHaveValue('CVH');
    const frame = (page) =>
      page.frames().find((f) => f.url().startsWith('https://ru.yummyani.me/'));
    for (const page of [host, guest])
      await expect(page.frameLocator('#mediaMount iframe').locator('#play')).toBeVisible();
    await expect.poll(() => frame(host).evaluate(() => window.snapshot().time)).toBe(32);
    await guest.locator('[data-playback="play"]').click();
    for (const page of [host, guest])
      await expect.poll(() => frame(page).evaluate(() => window.snapshot().playing)).toBe(true);
    await host.locator('[data-playback="pause"]').click();
    for (const page of [host, guest])
      await expect.poll(() => frame(page).evaluate(() => window.snapshot().playing)).toBe(false);
    await guest.locator('[data-playback="forward"]').click();
    await expect
      .poll(() => frame(host).evaluate(() => window.snapshot().time))
      .toBeGreaterThanOrEqual(42);
    await guest.locator('#watchEpisode').selectOption('4'.repeat(24));
    await guest.locator('#applySource').click();
    await expect(host.locator('#watchEpisode')).toHaveValue('4'.repeat(24));
    await expect(host.frameLocator('#mediaMount iframe').locator('#play')).toBeVisible();
    await expect.poll(() => frame(host).evaluate(() => window.snapshot().time)).toBe(0);
    await host.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://ru.yummyani.me',
          source: window,
          data: { key: 'player_play' },
        }),
      ),
    );
    await expect.poll(async () => (await state()).playback.playing).toBe(false);
    for (const size of [
      { width: 1366, height: 680 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await host.setViewportSize(size);
      expect((await host.locator('#mediaMount').boundingBox()).height).toBeGreaterThan(30);
      await expect(host.locator('[data-playback="play"]')).toBeInViewport();
      if (size.width <= 850) await host.locator('[data-panel="chat"]').click();
      await expect(host.locator('#chatInput')).toBeInViewport();
      expect(
        await host.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (size.width <= 850) await host.locator('[data-panel="watch"]').click();
      await host.screenshot({ path: `test-results/catalog-${size.width}.png` });
    }
    await guest.locator('#watchPlayer').selectOption('Alloha');
    await guest.locator('#applySource').click();
    await expect(host.locator('#playerNotice')).toContainText('вручную');
    await expect(host.locator('#queueCount')).toHaveText('1');
    await guest.locator('#watchPlayer').selectOption('Kodik');
    await guest.locator('#applySource').click();
    await expect(host.locator('#watchPlayer')).toHaveValue('Kodik');
    await expect(host.frameLocator('#mediaMount iframe').locator('#play')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test('members propose videos and see the same roulette elimination and winner', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  for (const context of [a, b]) {
    await context.route('https://media.example.org/**', (route) =>
      route.fulfill({
        path: path.resolve('tests/fixtures/sample.webm'),
        contentType: 'video/webm',
      }),
    );
  }
  try {
    const host = await a.newPage(),
      guest = await b.newPage();
    await createRoom(host);
    await joinRoom(guest, host.url());
    const root = new URL(host.url()).pathname.replace('/room/', '/api/rooms/');
    const headers = { origin: new URL(host.url()).origin };
    for (let i = 1; i <= 3; i++) {
      const response = await guest.request.post(`${root}/media`, {
        headers,
        data: { url: `https://media.example.org/${i}.mp4`, title: `Фильм ${i}` },
      });
      expect(response.status()).toBe(201);
    }
    await expect(host.locator('#queueCount')).toHaveText('3');
    await host.locator('#rouletteButton').click();
    await guest.locator('#rouletteButton').click();
    await host.getByRole('button', { name: 'Предложить: Фильм 1', exact: true }).click();
    await guest.getByRole('button', { name: 'Предложить: Фильм 2', exact: true }).click();
    await guest.getByRole('button', { name: 'Предложить: Фильм 3', exact: true }).click();
    await guest.locator('#rouletteAdd').click();
    await guest.locator('#urlInput').fill('https://media.example.org/4.mp4');
    await guest.locator('#mediaTitleInput').fill('Фильм 4');
    await guest.locator('#mediaSubmit').click();
    await expect(guest.locator('#rouletteDialog')).toBeVisible();
    await expect(
      guest.getByRole('button', { name: 'Отозвать: Фильм 4', exact: true }),
    ).toBeVisible();
    await expect(host.locator('#rouletteStatus')).toContainText('Предложено: 4');
    await expect(guest.locator('#rouletteStart')).toBeHidden();
    expect(
      (await guest.request.post(`${root}/roulette/draw`, { headers, data: {} })).status(),
    ).toBe(403);
    await host.locator('#rouletteStart').click();
    await expect(host.locator('#rouletteStage')).toBeVisible();
    await expect(guest.locator('#rouletteStage')).toBeVisible();
    const drawn = await (await host.request.get(root)).json();
    expect(
      (await host.request.delete(`${root}/media/${drawn.queue[0].id}`, { headers })).status(),
    ).toBe(409);
    await host.screenshot({ path: 'test-results/roulette-desktop.png' });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: 'test-results/roulette-mobile.png' });
    expect(
      await guest.locator('#rouletteDialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    // A reload during the draw resumes its server timeline and cannot reroll the result.
    await guest.reload();
    await expect(guest.locator('#rouletteDialog')).toBeVisible();
    await expect(host.locator('#rouletteStage')).toHaveClass(/finished/, { timeout: 15000 });
    await expect(guest.locator('#rouletteStage')).toHaveClass(/finished/);
    const winner = await host.locator('#rouletteStatus').textContent();
    await expect(guest.locator('#rouletteStatus')).toHaveText(winner);
    await expect(host.locator('#rouletteWheel .winner')).toHaveCount(1);
    const final = await (await host.request.get(root)).json();
    expect(final.playback.mediaId).toBe(drawn.roulette.order.at(-1));
    expect(final.queue).toHaveLength(4);
    await host.screenshot({ path: 'test-results/roulette-winner.png' });
    await host.locator('#rouletteReset').click();
    await expect(guest.locator('#rouletteStatus')).toContainText('Предложено: 0');
  } finally {
    await a.close();
    await b.close();
  }
});

test('source diagnostics explain support, ignore stale results and preserve ordinary adding on failure', async ({
  page,
}) => {
  await page.route('https://media.example.org/sample.webm', (route) =>
    route.fulfill({ path: path.resolve('tests/fixtures/sample.webm'), contentType: 'video/webm' }),
  );
  await createRoom(page);
  await page.locator('[data-source="link"]').click();
  await page.locator('#urlInput').fill('https://example.org/film');
  await page.locator('#inspectSourceButton').click();
  await expect(page.locator('#sourceDiagnosis')).toContainText('Не поддерживается');
  await expect(page.locator('#queueCount')).toHaveText('0');
  await page.locator('#urlInput').fill('https://youtu.be/aqz-KE-bpKQ');
  await page.locator('#inspectSourceButton').click();
  await expect(page.locator('#sourceDiagnosis')).toContainText('YouTube');
  await expect(page.locator('#sourceDiagnosis')).toContainText('зависят от источника');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/source/inspect', async (route) => {
    await gate;
    await route.fulfill({ json: { supported: true, provider: 'youtube', reason: 'Old result' } });
  });
  await page.locator('#inspectSourceButton').click();
  await page.locator('#urlInput').fill('https://media.example.org/sample.webm');
  release();
  await expect(page.locator('#sourceDiagnosis')).toBeHidden();
  await page.unroute('**/source/inspect');
  await page.route('**/source/inspect', (route) =>
    route.fulfill({ status: 503, json: { error: 'Unavailable' } }),
  );
  await page.locator('#inspectSourceButton').click();
  await expect(page.locator('#sourceDiagnosis')).toContainText('Можно попробовать обычную кнопку');
  await page.locator('#mediaSubmit').click();
  await expect(page.locator('#queueCount')).toHaveText('1');
  await expect
    .poll(() => page.locator('video').evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
});

test('participants plan local times and films; host confirms and starts the meeting for both clients', async ({
  browser,
}) => {
  const a = await browser.newContext({ timezoneId: 'Asia/Tomsk' }),
    b = await browser.newContext({ timezoneId: 'America/New_York' });
  for (const context of [a, b])
    await context.route('https://media.example.org/**', (route) =>
      route.fulfill({
        path: path.resolve('tests/fixtures/sample.webm'),
        contentType: 'video/webm',
      }),
    );
  try {
    const host = await a.newPage(),
      guest = await b.newPage();
    await createRoom(host);
    await joinRoom(guest, host.url());
    const api = new URL(host.url()).pathname.replace('/room/', '/api/rooms/');
    await host.request.post(api + '/media', {
      headers: { origin: new URL(host.url()).origin },
      data: { url: 'https://media.example.org/a.webm', title: 'Вечерний фильм' },
    });
    await expect(guest.locator('#queueCount')).toHaveText('1');
    await guest.locator('#scheduleButton').click();
    await guest.locator('#meetingTitle').fill('Наш общий вечер');
    const local = await guest.evaluate(() => {
      const d = new Date(Date.now() + 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T19:30`;
    });
    await guest.locator('#meetingTime').fill(local);
    const media = (await (await host.request.get(api)).json()).queue[0];
    await guest.locator('#meetingMedia').selectOption(media.id);
    await guest.locator('#meetingSubmit').click();
    await expect(guest.locator('.meeting-card')).toHaveCount(1);
    await host.locator('#scheduleButton').click();
    await expect(host.locator('.meeting-header')).toContainText('Наш общий вечер');
    const expectedTime = await host.locator('.meeting-card time').getAttribute('datetime');
    expect(await guest.locator('.meeting-card time').getAttribute('datetime')).toBe(expectedTime);
    expect(await guest.locator('.meeting-card time').textContent()).not.toBe(
      await host.locator('.meeting-card time').textContent(),
    );
    await host.getByRole('button', { name: 'Мне удобно', exact: true }).click();
    await expect(guest.locator('.meeting-card')).toContainText('удобно: 2');
    await expect(guest.getByRole('button', { name: 'Подтвердить', exact: true })).toHaveCount(0);
    await host.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await expect(guest.locator('.meeting-badge')).toHaveText('Подтверждено');
    await guest.reload();
    await guest.locator('#scheduleButton').click();
    await expect(guest.locator('.meeting-badge')).toHaveText('Подтверждено');
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(
      await guest.locator('#scheduleDialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await guest.screenshot({ path: 'test-results/schedule-mobile.png' });
    await host.screenshot({ path: 'test-results/schedule-desktop.png' });
    await host.getByRole('button', { name: 'Начать встречу', exact: true }).click();
    await expect(host.locator('#scheduleDialog')).toBeHidden();
    await expect(guest.locator('.meeting-badge')).toHaveText('Начали просмотр');
    await guest.locator('[data-close="scheduleDialog"]').click();
    await expect(host.locator('#nextMeeting')).toBeHidden();
    for (const size of [
      { width: 1366, height: 680 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await host.setViewportSize(size);
      await expect(host.locator('#scheduleButton')).toBeInViewport();
      if (size.width <= 850) await host.locator('[data-panel="chat"]').click();
      await expect(host.locator('#chatInput')).toBeInViewport();
      expect(
        await host.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (size.width <= 850) await host.locator('[data-panel="watch"]').click();
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test('LordFilm CVH runs in an opaque sandbox and synchronizes across viewers', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  for (const context of [a, b])
    await context.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined });
    });
  for (const context of [a, b])
    await context.route('https://player.cdnvideohub.com/s2/stable/video-player.umd.js', (route) =>
      route.fulfill({
        path: path.resolve('tests/fixtures/lordfilm-component.js'),
        contentType: 'application/javascript',
        headers: { 'access-control-allow-origin': '*' },
      }),
    );
  try {
    const host = await a.newPage(),
      guest = await b.newPage();
    await createRoom(host);
    await joinRoom(guest, host.url());
    await guest.locator('[data-source="link"]').click();
    await guest.locator('#urlInput').fill('https://8.lordfilms.mobile/1773/');
    await guest.locator('#inspectSourceButton').click();
    await expect(guest.locator('#sourceDiagnosis')).toContainText('CVH');
    await guest.locator('#mediaSubmit').click();
    for (const page of [host, guest])
      await expect(page.frameLocator('#mediaMount iframe').locator('video-player')).toHaveText(
        'Test CVH',
      );
    await expect(host.locator('#playerNotice')).toBeHidden();
    const frame = (page) => page.frames().find((f) => f.url().includes('/lordfilm-player.html'));
    expect(
      await frame(host).evaluate(() => {
        try {
          localStorage.getItem('syncplayer.name');
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    await guest.locator('[data-playback="play"]').click();
    const api = new URL(host.url()).pathname.replace('/room/', '/api/rooms/');
    const state = async () => (await host.request.get(api)).json();
    await expect.poll(async () => (await state()).playback.playing).toBe(true);
    await guest.locator('[data-playback="forward"]').click();
    await expect.poll(async () => (await state()).playback.position).toBeGreaterThanOrEqual(10);
    await host.locator('[data-playback="pause"]').click();
    await expect.poll(async () => (await state()).playback.playing).toBe(false);
    const before = (await state()).playbackRevision;
    await host.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'null',
          source: window,
          data: { key: 'player_play', nonce: 'wrong' },
        }),
      ),
    );
    await host.waitForTimeout(400);
    expect((await state()).playbackRevision).toBe(before);
    expect(await host.locator('#mediaMount iframe').getAttribute('sandbox')).not.toContain(
      'allow-same-origin',
    );
    await frame(host).evaluate(() =>
      document.querySelector('video-player').dispatchEvent(new CustomEvent('error')),
    );
    await expect(host.locator('#playerNotice')).toContainText('CORS');
    await expect(host.locator('#sourcePageLink')).toHaveAttribute(
      'href',
      'https://8.lordfilms.mobile/1773/',
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test('Rutube search imports metadata and synchronizes iframe playback without trusting unrelated messages or ad time', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  for (const context of [a, b]) {
    await context.route('https://rutube.ru/play/embed/**', (route) =>
      route.fulfill({ path: path.resolve('tests/fixtures/rutube.html'), contentType: 'text/html' }),
    );
    await context.route('https://pic.rtbcdn.ru/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150"><rect width="100" height="150" fill="#8a60bb"/></svg>',
      }),
    );
  }
  try {
    const host = await a.newPage(),
      guest = await b.newPage();
    await createRoom(host);
    await joinRoom(guest, host.url());
    await guest.locator('#addButton').click();
    await guest.locator('[data-type="search"]').click();
    await guest.locator('#catalogSearchQuery').fill('Парни со стволами');
    await guest.locator('#searchSubmit').click();
    await expect(guest.locator('#searchStatus')).toContainText('Не ответили: YummyAnime');
    await expect(guest.locator('.search-result strong')).toHaveText('Тестовый фильм Rutube');
    await guest.screenshot({ path: 'test-results/search-desktop.png' });
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(
      await guest.locator('#addDialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await guest.screenshot({ path: 'test-results/search-mobile.png' });
    await guest
      .getByRole('button', { name: 'Добавить: Тестовый фильм Rutube', exact: true })
      .click();
    await expect(host.locator('#queueList')).toContainText('Тестовый фильм Rutube');
    await expect(host.locator('#queueList img')).toHaveAttribute(
      'src',
      'https://pic.rtbcdn.ru/video/test.jpg',
    );
    for (const page of [host, guest])
      await expect(page.frameLocator('#mediaMount iframe').locator('#play')).toBeVisible();
    const frame = (page) =>
      page.frames().find((f) => f.url().startsWith('https://rutube.ru/play/embed/'));
    // Mobile watch panel is active by default; these controls are inside the player frame.
    await guest.frameLocator('#mediaMount iframe').locator('#play').click();
    await expect.poll(() => frame(host).evaluate(() => window.snapshot().playing)).toBe(true);
    await guest.frameLocator('#mediaMount iframe').locator('#seek').click();
    await expect
      .poll(() => frame(host).evaluate(() => window.snapshot().time))
      .toBeGreaterThanOrEqual(39);
    await host.frameLocator('#mediaMount iframe').locator('#pause').click();
    await expect.poll(() => frame(guest).evaluate(() => window.snapshot().playing)).toBe(false);
    const api = new URL(host.url()).pathname.replace('/room/', '/api/rooms/');
    await host.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://rutube.ru',
          source: window,
          data: JSON.stringify({ type: 'player:changeState', data: { state: 'playing' } }),
        }),
      ),
    );
    await host.frameLocator('#mediaMount iframe').locator('#ad').click();
    await host.waitForTimeout(700);
    const state = await (await host.request.get(api)).json();
    expect(state.playback.position).toBeLessThan(100);
    expect(state.playback.playing).toBe(false);
    await guest.locator('#addButton').click();
    await guest.locator('[data-type="link"]').click();
    await guest
      .locator('#urlInput')
      .fill(
        '<iframe src="https://rutube.ru/play/embed/df566fac28e4853bbf4e6389a6d08cda/" onload="window.xss=true"></iframe>',
      );
    await guest.locator('#mediaTitleInput').fill('Мой вариант');
    await guest.locator('#mediaSubmit').click();
    await expect(host.locator('#queueList')).toContainText('Мой вариант');
    expect(await guest.evaluate(() => Boolean(window.xss))).toBe(false);
    await host.locator('#rouletteButton').click();
    await expect(host.locator('#rouletteCandidates img')).toHaveCount(2);
  } finally {
    await a.close();
    await b.close();
  }
});

test('discovered page video joins the queue and late viewers follow playback', async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  try {
    const fixture = await readFile('tests/fixtures/sample.webm');
    for (const context of [hostContext, guestContext]) {
      await context.route('https://mdn.github.io/**/clip.webm', (route) => {
        // Chromium needs a partial response to make the remote video seekable.
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
        if (!range) return route.fulfill({ body: fixture, contentType: 'video/webm' });
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), fixture.length - 1) : fixture.length - 1;
        return route.fulfill({
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${fixture.length}`,
          },
          body: fixture.subarray(start, end + 1),
          contentType: 'video/webm',
        });
      });
    }
    await createRoom(host);
    await host.locator('[data-source="link"]').click();
    await host
      .locator('#urlInput')
      .fill(
        'https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/multiple-video-formats.html',
      );
    await host.getByRole('button', { name: 'Найти видео на странице' }).click();
    await host.locator('#discoveryResults button').filter({ hasText: 'WEBM' }).click();
    await expect(host.locator('#mediaTitleInput')).toHaveValue('Static HTML example');
    await host.locator('#mediaSubmit').click();
    await expect(host.locator('#queueList')).toContainText('Static HTML example');
    const video = (page) => page.locator('#mediaMount video');
    await expect.poll(() => video(host).evaluate((el) => el.readyState)).toBeGreaterThan(1);
    await video(host).evaluate((el) => {
      el.currentTime = 3;
      return el.play();
    });
    await joinRoom(guest, host.url());
    await expect
      .poll(() => video(guest).evaluate((el) => !el.paused && el.currentTime > 2))
      .toBe(true);
    await video(guest).evaluate((el) => el.pause());
    await expect.poll(() => video(host).evaluate((el) => el.paused)).toBe(true);
    await video(guest).evaluate((el) => {
      el.currentTime = 8;
    });
    await expect
      .poll(() => video(host).evaluate((el) => Math.abs(el.currentTime - 8)))
      .toBeLessThan(0.6);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
