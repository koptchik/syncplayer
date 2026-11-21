import { lstat, mkdir, readdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './validation.mjs';

export const uploadMimeTypes = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};
const uploadName = /^[a-f0-9]{32}\.(?:mp4|webm|m4v|mov|mkv)(?:\.part)?$/;
const retryMs = 60000;

export async function openUploads(config, protectedNames) {
  const storage = new UploadStorage(config);
  await mkdir(storage.directory, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(storage.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !uploadName.test(entry.name)) {
      storage.unmanagedEntries++;
      continue;
    }
    let info;
    try {
      info = await lstat(storage.path(entry.name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile()) continue;
    const expiresAt = entry.name.endsWith('.part')
      ? 0
      : protectedNames.has(entry.name)
        ? undefined
        : info.mtimeMs + config.roomTtlMs;
    storage.record(entry.name, info.size, expiresAt);
  }
  return storage;
}

class UploadStorage {
  constructor(config) {
    this.config = config;
    this.directory = path.join(config.dataDir, 'uploads');
    this.files = new Map();
    this.usedBytes = 0;
    this.reservedBytes = 0;
    this.active = 0;
    this.unmanagedEntries = 0;
  }
  path(name) {
    return path.join(this.directory, name);
  }
  async reserve(bytes) {
    const disk = bytes ? await statfs(this.directory) : null;
    if (this.active >= 4) throw new AppError(409, 'Дождитесь завершения текущей загрузки.');
    if (bytes && this.usedBytes + this.reservedBytes + bytes > this.config.maxStorageBytes)
      throw new AppError(507, 'На сервере закончился лимит хранения.');
    if (
      disk &&
      disk.bavail * disk.bsize - this.reservedBytes - bytes < this.config.minFreeStorageBytes
    )
      throw new AppError(507, 'На диске не хватает свободного места для этой загрузки.');
    this.active++;
    this.reservedBytes += bytes;
    return () => {
      this.active--;
      this.reservedBytes -= bytes;
    };
  }
  record(name, bytes, expiresAt) {
    this.usedBytes += bytes - (this.files.get(name)?.bytes ?? 0);
    this.files.set(name, { bytes, expiresAt });
  }
  async remove(name, fallbackBytes = 0) {
    if (typeof name !== 'string' || !uploadName.test(name)) return false;
    try {
      await unlink(this.path(name));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.record(name, this.files.get(name)?.bytes ?? fallbackBytes, Date.now() + retryMs);
        console.error('Could not remove upload:', error.code);
        return false;
      }
    }
    this.usedBytes -= this.files.get(name)?.bytes ?? 0;
    this.files.delete(name);
    return true;
  }
  async prune({ allOrphans = false, now = Date.now() } = {}) {
    let removed = 0;
    for (const [name, { expiresAt }] of this.files) {
      if (expiresAt === undefined || (!allOrphans && expiresAt > now)) continue;
      if (await this.remove(name)) removed++;
    }
    return removed;
  }
  summary() {
    let orphanBytes = 0;
    let orphanFiles = 0;
    for (const entry of this.files.values()) {
      if (entry.expiresAt === undefined) continue;
      orphanBytes += entry.bytes;
      orphanFiles++;
    }
    return {
      trackedFiles: this.files.size,
      trackedBytes: this.usedBytes,
      orphanFiles,
      orphanBytes,
      unmanagedEntries: this.unmanagedEntries,
    };
  }
}
