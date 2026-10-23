import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';
import { configuration } from '../src/server/config.mjs';
import { createApplication } from '../src/server/app.mjs';

const publicOrigin = 'https://stream.koptchik.duckdns.org';

test('configured public invitations work alongside local access without weakening Origin checks', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'syncplayer-origin-'));
  const app = await createApplication(
    configuration({ PUBLIC_ORIGIN: publicOrigin, DATA_DIR: dataDir }),
  );
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const port = app.server.address().port;
    const localHost = `127.0.0.1:${port}`;
    const call = (
      endpoint,
      { host = localHost, origin = `http://${localHost}`, method = 'GET', data, headers = {} } = {},
    ) =>
      new Promise((resolve, reject) => {
        const payload = data ? JSON.stringify(data) : undefined;
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: endpoint,
            method,
            headers: {
              Host: host,
              Origin: origin,
              ...(payload
                ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                  }
                : {}),
              ...headers,
            },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => {
              text += chunk;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }),
            );
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    const local = await call('/api/rooms', {
      method: 'POST',
      data: { name: 'Host', title: 'Local room' },
    });
    assert.equal(local.status, 201);
    assert.equal(local.body.inviteUrl, `${publicOrigin}/room/${local.body.id}`);
    assert.doesNotMatch(local.headers['set-cookie'][0], /; Secure/);
    assert.equal(local.headers['strict-transport-security'], undefined);
    assert.doesNotMatch(local.headers['content-security-policy'], /upgrade-insecure-requests/);
    const external = await call(`/api/rooms/${local.body.id}/join`, {
      method: 'POST',
      host: new URL(publicOrigin).host,
      origin: publicOrigin,
      data: { name: 'Friend' },
    });
    assert.equal(external.status, 200);
    assert.equal(external.body.me.isHost, false);
    assert.equal(external.body.inviteUrl, local.body.inviteUrl);
    assert.match(external.headers['set-cookie'][0], /; Secure/);
    assert.match(external.headers['strict-transport-security'], /max-age=/);
    assert.match(external.headers['content-security-policy'], /upgrade-insecure-requests/);
    const cookie = external.headers['set-cookie'][0].split(';')[0];
    const ws = new WebSocket(`ws://${localHost}/api/rooms/${local.body.id}/socket`, {
      headers: { Host: new URL(publicOrigin).host, Origin: publicOrigin, Cookie: cookie },
    });
    const state = once(ws, 'message');
    await once(ws, 'open');
    const [message] = await state;
    assert.equal(JSON.parse(message).room.inviteUrl, local.body.inviteUrl);
    const closed = once(ws, 'close');
    ws.close();
    await closed;
    for (const requestOptions of [
      { host: new URL(publicOrigin).host, origin: 'https://attacker.example' },
      { host: new URL(publicOrigin).host, origin: 'http://stream.koptchik.duckdns.org' },
      { host: 'attacker.example', origin: 'https://attacker.example' },
      {
        host: localHost,
        origin: publicOrigin,
        headers: { 'X-Forwarded-Host': new URL(publicOrigin).host, 'X-Forwarded-Proto': 'https' },
      },
    ]) {
      assert.equal(
        (
          await call('/api/rooms', {
            method: 'POST',
            data: { name: 'Bad', title: 'Bad' },
            ...requestOptions,
          })
        ).status,
        403,
      );
    }
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('public origin configuration rejects ambiguous URLs', () => {
  for (const url of [
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#fragment',
  ]) {
    assert.throws(() => configuration({ PUBLIC_ORIGIN: url }));
  }
  assert.equal(configuration({ PUBLIC_ORIGIN: publicOrigin + '/' }).publicOrigin, publicOrigin);
});
