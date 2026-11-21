import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AppError } from './validation.mjs';

export const ownerPassword = z
  .string()
  .min(12, 'Пароль должен содержать минимум 12 символов.')
  .max(128, 'Пароль должен содержать не больше 128 символов.');
export const ownerLogin = z
  .object({ name: z.string().trim().min(1).max(40), password: ownerPassword })
  .strict();

const derive = promisify(scrypt);
const parameters = { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
let active = 0;

async function hash(password, salt) {
  if (active >= 2) throw new AppError(429, 'Проверка пароля занята. Повторите чуть позже.');
  active++;
  try {
    return await derive(password, salt, 32, parameters);
  } finally {
    active--;
  }
}

export async function createOwner(name, password) {
  const salt = randomBytes(16).toString('hex');
  const key = await hash(password, salt);
  return { name, salt, key: key.toString('hex') };
}

export async function verifyOwner(owner, { name, password }) {
  const key = await hash(password, owner.salt);
  return timingSafeEqual(key, Buffer.from(owner.key, 'hex')) && name === owner.name;
}
