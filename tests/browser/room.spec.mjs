import { test, expect } from '@playwright/test';
import path from 'node:path';

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
  } finally {
    await a.close();
    await b.close();
  }
});

test('a catalog page offers player, dubbing and episode selection before adding to the queue', async ({
  page,
}) => {
  await page.route('https://kodikplayer.com/**', (route) =>
    route.fulfill({ path: path.resolve('tests/fixtures/kodik.html'), contentType: 'text/html' }),
  );
  await createRoom(page);
  await page.route('**/api/rooms/*/resolve', (route) =>
    route.fulfill({
      json: {
        title: 'Example',
        options: [
          {
            id: 1,
            player: 'Kodik',
            dubbing: 'Voice A',
            episode: '1',
            title: 'Example · Voice A · 1',
            supported: true,
            url: 'https://kodikplayer.com/season/123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/720p?episode=1',
          },
          {
            id: 2,
            player: 'Kodik',
            dubbing: 'Voice B',
            episode: '2',
            title: 'Example · Voice B · 2',
            supported: true,
            url: 'https://kodikplayer.com/season/123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/720p?episode=2',
          },
          { id: 3, player: 'Other', dubbing: 'Voice B', episode: '2', supported: false },
        ],
      },
    }),
  );
  await page.locator('[data-source="link"]').click();
  await page.locator('#urlInput').fill('https://old.yummyani.me/catalog/item/example');
  await page.locator('#mediaSubmit').click();
  await expect(page.locator('#pageChoices')).toBeVisible();
  await expect(page.locator('#queueCount')).toHaveText('0');
  await page.locator('#pageDubbing').selectOption('Voice B');
  await expect(page.locator('#pageEpisode')).toHaveValue('2');
  await page.locator('#mediaSubmit').click();
  await expect(page.locator('#queueList')).toContainText('Example · Voice B · 2');
  await expect(page.locator('#mediaMount iframe')).toHaveAttribute('src', /episode=2/);
});
