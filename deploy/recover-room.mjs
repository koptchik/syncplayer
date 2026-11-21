import { randomBytes } from 'node:crypto';
import { copyFileSync, constants } from 'node:fs';
import { configuration } from '../src/server/config.mjs';
import { createOwner, ownerLogin } from '../src/server/room-owner.mjs';
import { RoomStore } from '../src/server/rooms.mjs';

const password = randomBytes(24).toString('base64url');
const { name } = ownerLogin.parse({ name: process.argv[2], password });
const store = new RoomStore(configuration());
store.loadPermanent();
const [room] = store.rooms.values();
if (!room) throw new Error('No permanent room to recover.');
if (room.owner) throw new Error('The room already has an owner profile.');

const owner = await createOwner(name, password);
const filename = store.permanentFilename();
const backup = `${filename}.before-owner-${Date.now()}`;
copyFileSync(filename, backup, constants.COPYFILE_EXCL);
room.owner = owner;
store.persist(room);
const origin = store.config.publicOrigin || '';
console.log(
  `Room: ${origin}/room/${room.id}\nOwner: ${name}\nPassword: ${password}\nBackup: ${backup}`,
);
