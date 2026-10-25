import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RoomStore } from '../src/server/rooms.mjs';
import { configuration } from '../src/server/config.mjs';

test('roulette accepts member proposals, locks a fair distinct draw and persists its winner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-roulette-'));
  try {
    const store = new RoomStore(configuration({ DATA_DIR: dir }));
    const { room, member: host } = store.create({
      name: 'Host',
      title: 'Roulette',
      permanent: true,
    });
    const { member: guest } = store.join(room, 'Guest');
    const items = Array.from({ length: 4 }, (_, i) =>
      store.add(room, {
        type: 'remote',
        url: `https://media.example.org/${i}.mp4`,
        title: `Film ${i}`,
      }),
    );
    assert.throws(() => store.nominate(room, '0'.repeat(32), guest), { status: 404 });
    store.nominate(room, items[0].id, guest);
    store.nominate(room, items[1].id, guest);
    store.nominate(room, items[2].id, guest);
    assert.throws(() => store.nominate(room, items[3].id, guest), { status: 409 });
    store.nominate(room, items[2].id, guest); // Withdraw own proposal.
    store.nominate(room, items[0].id, host); // Duplicate does not gain a second slot.
    assert.throws(() => store.draw(room, guest), { status: 403 });
    store.draw(room, host);
    assert.equal(room.roulette.order.length, 2);
    assert.equal(new Set(room.roulette.order).size, 2);
    assert.deepEqual(
      [...room.roulette.order].sort(),
      items
        .slice(0, 2)
        .map((m) => m.id)
        .sort(),
    );
    assert.equal(room.playback.mediaId, room.roulette.order.at(-1));
    assert.equal(room.playback.playing, false);
    assert.throws(() => store.draw(room, host), { status: 409 });
    assert.throws(() => store.nominate(room, items[3].id, guest), { status: 409 });
    assert.throws(() => store.select(room, items[3].id, guest), { status: 409 });
    assert.throws(() => store.control(room, { ...room.playback, playing: true }, guest), {
      status: 409,
    });
    assert.throws(() => store.resetDraw(room, host), { status: 409 });
    store.persist(room);
    const restored = new RoomStore(configuration({ DATA_DIR: dir }));
    restored.loadPermanent();
    assert.deepEqual(restored.get(room.id).roulette, room.roulette);
    room.roulette.endsAt = Date.now() - 1;
    assert.throws(() => store.resetDraw(room, guest), { status: 403 });
    store.resetDraw(room, host);
    assert.equal(room.queue.length, 4);
    assert.deepEqual(room.roulette, { nominations: [] });
    assert.throws(() => store.draw(room, host), { status: 409 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
