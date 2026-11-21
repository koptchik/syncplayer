import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';
import { AppError } from './validation.mjs';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked.addSubnet(address, prefix);
export const isPublicIPv4 = (address) => isIPv4(address) && !blocked.check(address);
export function createFixedHostFetcher({
  hostname,
  allowedPath,
  label,
  dnsLookup = lookup,
  httpsRequest = request,
  dnsTimeoutMs = 8000,
  responseTimeoutMs = 12000,
  maxResponseBytes = 2 * 1024 * 1024,
  verifyContentType,
} = {}) {
  return async function readPage(pathname) {
    if (!allowedPath.test(pathname)) throw new AppError(400, 'Недопустимый путь источника.');
    let timer;
    const addresses = await Promise.race([
      dnsLookup(hostname, { family: 4, all: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError(504, `${label} не ответил.`)), dnsTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!addresses.length || addresses.some(({ address }) => !isPublicIPv4(address)))
      throw new AppError(502, 'Недопустимый сетевой адрес источника.');
    // The validated public address is pinned for the HTTPS connection; redirects are never followed.
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname,
          path: pathname,
          family: 4,
          ...(verifyContentType ? { agent: false } : {}),
          method: 'GET',
          lookup: (_host, options, callback) =>
            options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
          headers: { Accept: 'text/html, application/json', 'User-Agent': 'Syncplayer/0.1' },
        },
        (res) => {
          if (res.statusCode !== 200) {
            req.destroy(
              new AppError(
                502,
                `${label} ответил ${res.statusCode}; повторите позже или вставьте код плеера.`,
              ),
            );
            return;
          }
          if (verifyContentType && !verifyContentType.test(res.headers['content-type'] ?? '')) {
            req.destroy(new AppError(415, 'По этому адресу не HTML-страница.'));
            return;
          }
          let size = 0;
          const chunks = [];
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              req.destroy(new AppError(502, 'Ответ источника слишком большой.'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        },
      );
      const timeout = setTimeout(
        () => req.destroy(new AppError(504, `${label} не ответил вовремя.`)),
        responseTimeoutMs,
      );
      req.on('error', reject);
      req.on('close', () => clearTimeout(timeout));
      req.end();
    });
  };
}
