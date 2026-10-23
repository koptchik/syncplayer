import path from 'node:path';

function integer(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error('Invalid numeric configuration');
  return n;
}

export function configuration(env = process.env) {
  const publicUrl = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
  if (
    publicUrl &&
    (publicUrl.protocol !== 'https:' ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== '/' ||
      publicUrl.search ||
      publicUrl.hash)
  ) {
    throw new Error(
      'PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query or fragment.',
    );
  }
  const publicOrigin = publicUrl?.origin || null;
  return {
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 3000, 0, 65535),
    publicOrigin,
    allowedHosts: new Set(
      (env.ALLOWED_HOSTS || 'localhost,127.0.0.1,[::1]')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
    dataDir: path.resolve(env.DATA_DIR || '.data'),
    maxFileBytes: integer(env.MAX_FILE_BYTES, 4 * 1024 ** 3, 1, 100 * 1024 ** 3),
    maxStorageBytes: integer(env.MAX_STORAGE_BYTES, 10 * 1024 ** 3, 1, 1024 ** 4),
    roomTtlMs: integer(env.ROOM_TTL_HOURS, 24, 1, 168) * 3600000,
    maxRooms: 100,
    maxMembers: 32,
  };
}
