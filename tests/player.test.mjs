import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayerController } from '../public/players.js';

function setup(play) {
  const blocked = [];
  const notices = [];
  const player = new PlayerController(
    { replaceChildren() {} },
    { blocked: (value) => blocked.push(value), notice: (text) => notices.push(text) },
  );
  player.mediaId = 'current';
  player.ready = true;
  player.adapter = {
    state: () => ({ position: 5, playing: false, rate: 1 }),
    seek() {},
    play,
    destroy() {},
  };
  return { player, blocked, notices };
}

const playback = {
  mediaId: 'current',
  position: 5,
  playing: true,
  rate: 1,
};

function apply(player, state = playback) {
  return player.apply({ ...state, updatedAt: Date.now() });
}

test('player distinguishes a blocked autoplay from an unavailable source', async () => {
  const denied = setup(async () => {
    throw new DOMException('Autoplay denied', 'NotAllowedError');
  });
  await apply(denied.player);
  assert.deepEqual(denied.blocked, [true]);
  assert.deepEqual(denied.notices, []);

  const unsupported = setup(async () => {
    throw new DOMException('Unsupported video', 'NotSupportedError');
  });
  await apply(unsupported.player);
  assert.deepEqual(unsupported.blocked, [false]);
  assert.match(unsupported.notices[0], /Не удалось воспроизвести видео/);
});

test('a player discarded during source change cannot report a late playback failure', async () => {
  const pending = Promise.withResolvers();
  const { player, blocked, notices } = setup(() => pending.promise);
  const started = apply(player);
  await player.load(null);
  pending.reject(new DOMException('Late rejection', 'NotAllowedError'));
  await started;
  assert.deepEqual(blocked, [false]);
  assert.deepEqual(notices, []);
});

test('a newer pause takes precedence over a pending play failure', async () => {
  const pending = Promise.withResolvers();
  const { player, blocked, notices } = setup(() => pending.promise);
  const started = apply(player);
  await apply(player, { ...playback, playing: false });
  pending.reject(new DOMException('Late rejection', 'NotSupportedError'));
  await started;
  assert.deepEqual(blocked, [false]);
  assert.deepEqual(notices, []);
});
