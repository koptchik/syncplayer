import { createHash } from 'node:crypto';
import { AppError } from './validation.mjs';

const receiptTtlMs = 24 * 60 * 60 * 1000;
const receiptLimit = 128;

export function requestKey(req, operation) {
  const value = req.get('Idempotency-Key');
  if (value === undefined) return null;
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value))
    throw new AppError(400, 'Некорректный ключ операции.');
  return `${req.member.id}:${operation}:${value}`;
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function findReceipt(room, key) {
  if (!key) return undefined;
  const now = Date.now();
  return room.receipts?.find((entry) => entry.key === key && entry.expiresAt > now);
}

export function replay(receipt, hash) {
  if (receipt.hash !== hash)
    throw new AppError(409, 'Этот ключ уже использован для другого запроса.');
  return receipt.response;
}

export function recordReceipt(room, key, hash, response) {
  if (!key) return;
  const now = Date.now();
  const entries = room.receipts?.filter((entry) => entry.expiresAt > now) ?? [];
  entries.push({ key, hash, response, expiresAt: now + receiptTtlMs });
  room.receipts = entries.slice(-receiptLimit);
}
