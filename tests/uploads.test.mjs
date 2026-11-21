import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { configuration } from '../src/server/config.mjs';
import { RoomStore } from '../src/server/rooms.mjs';
import { openUploads } from '../src/server/uploads.mjs';

const run = promisify(execFile);
const name = (number) => `${number.toString(16).padStart(32, '0')}.webm`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'syncplayer-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'uploads'));
  return {
    dir,
    config: configuration({ DATA_DIR: dir }),
    file: (filename) => path.join(dir, 'uploads', filename),
  };
}

test('upload cleanup removes stale or unfinished files and preserves the active queue', async (t) => {
  const { config, file } = await fixture(t);
  const stale = name(1);
  const linked = name(2);
  const recent = name(3);
  const partial = `${name(4)}.part`;
  for (const item of [stale, linked, recent, partial, 'notes.txt']) {
    await writeFile(file(item), 'example');
  }
  await utimes(file(stale), 0, 0);
  await utimes(file(linked), 0, 0);
  await mkdir(file(name(5)));

  const uploads = await openUploads(config, new Set([linked]));
  assert.deepEqual(uploads.summary(), {
    trackedFiles: 4,
    trackedBytes: 28,
    orphanFiles: 3,
    orphanBytes: 21,
    unmanagedEntries: 2,
  });
  assert.equal(await uploads.prune(), 2);
  assert.deepEqual((await readdir(uploads.directory)).sort(), [
    linked,
    recent,
    name(5),
    'notes.txt',
  ]);
  assert.equal(await uploads.prune({ allOrphans: true }), 1);
  assert.equal(await readFile(file(linked), 'utf8'), 'example');
  assert.equal(uploads.summary().orphanFiles, 0);
});

test('in-flight reservations enforce quota and the filesystem reserve independently', async (t) => {
  const { config } = await fixture(t);
  const quota = await openUploads({ ...config, maxStorageBytes: 12 }, new Set());
  quota.record(name(1), 3);
  const first = await quota.reserve(6);
  await assert.rejects(quota.reserve(4), { status: 507, message: /лимит/ });
  first();
  (await quota.reserve(4))();

  const disk = await openUploads(
    { ...config, minFreeStorageBytes: Number.MAX_SAFE_INTEGER },
    new Set(),
  );
  await assert.rejects(disk.reserve(1), { status: 507, message: /свободного места/ });
});

test('offline maintenance reports data, leaves the permanent queue intact during orphan cleanup, and closes it on request', async (t) => {
  const { dir, config, file } = await fixture(t);
  const store = new RoomStore(config);
  const { room } = store.create(
    { name: 'Owner', title: 'Permanent', permanent: true },
    { name: 'Owner' },
  );
  store.add(room, { type: 'file', diskName: name(1), bytes: 5 });
  store.persist(room);
  await writeFile(file(name(1)), 'movie');
  await writeFile(file(name(2)), 'orphan');
  await writeFile(file('notes.txt'), 'keep');
  const maintain = async (mode) => {
    const response = await run(process.execPath, ['deploy/storage-maintenance.mjs', mode], {
      env: { ...process.env, DATA_DIR: dir },
    });
    return JSON.parse(response.stdout);
  };
  const report = await maintain('report');
  assert.equal(report.permanentRoomExisted, true);
  assert.equal(report.before.trackedBytes, 11);
  assert.equal(report.before.orphanBytes, 6);
  assert.equal(await readFile(file(name(2)), 'utf8'), 'orphan');
  const pruned = await maintain('clean-orphans');
  assert.equal(pruned.trackedBytesFreed, 6);
  assert.equal(await readFile(file(name(1)), 'utf8'), 'movie');

  const result = await maintain('close-and-clean');
  assert.equal(result.roomClosed, true);
  assert.equal(result.trackedBytesFreed, 5);
  assert.equal(result.after.trackedFiles, 0);
  await assert.rejects(stat(store.permanentFilename()), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.dirname(file(name(1)))), ['notes.txt']);
  const repeated = await maintain('close-and-clean');
  assert.equal(repeated.roomClosed, false);
  assert.equal(repeated.after.trackedBytes, 0);
});
