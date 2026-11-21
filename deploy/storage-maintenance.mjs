import { configuration } from '../src/server/config.mjs';
import { RoomStore } from '../src/server/rooms.mjs';
import { openUploads } from '../src/server/uploads.mjs';

const mode = process.argv[2] ?? 'report';
if (!['report', 'clean-orphans', 'close-and-clean'].includes(mode) || process.argv.length > 3) {
  console.error('Usage: storage-maintenance.mjs [report|clean-orphans|close-and-clean]');
  process.exit(2);
}

const config = configuration();
const store = new RoomStore(config);
store.loadPermanent();
const [room] = store.rooms.values();
const uploads = await openUploads(config, store.uploadNames());
const before = uploads.summary();
let roomClosed = false;
if (mode === 'close-and-clean' && room) {
  store.closePermanent(room);
  roomClosed = true;
  await Promise.all(room.queue.map(({ diskName }) => uploads.remove(diskName)));
}
if (mode !== 'report') await uploads.prune({ allOrphans: true });
const after = uploads.summary();
console.log(
  JSON.stringify(
    {
      mode,
      permanentRoomExisted: Boolean(room),
      roomClosed,
      before,
      after,
      trackedBytesFreed: before.trackedBytes - after.trackedBytes,
    },
    null,
    2,
  ),
);
if (mode !== 'report' && after.orphanFiles) process.exitCode = 1;
