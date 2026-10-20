// Phase 10 row 4: run inside an ACP agent or a P9 terminal. Every environment value and every small file in the working
// directory is tried as a remote session cookie and as the desktop cookie against the remote port. Prints one JSON line.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';

const [port, host] = process.argv.slice(2);
// Only values that fit in a cookie header; the rest could not be sent as one anyway.
const candidates = new Set(Object.values(process.env).filter((value) => value && value.length >= 16 && /^[\x21-\x3a\x3c-\x7e]+$/.test(value)));
for (const name of readdirSync('.')) {
  try {
    if (statSync(name).isFile() && statSync(name).size < 65536) {
      for (const token of readFileSync(name, 'utf8').match(/[A-Za-z0-9_-]{16,}/g) ?? []) candidates.add(token);
    }
  } catch {}
}
const ask = (cookie) => new Promise((resolve) => {
  const req = request({ hostname: '127.0.0.1', port, path: '/files?path=note.txt', headers: { host, cookie } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', () => resolve('error'));
  req.end();
});
const statuses = {};
for (const token of candidates) {
  for (const cookie of ['p9s=' + token, 'p9=' + token]) {
    const status = await ask(cookie);
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
}
const names = Object.keys(process.env).filter((name) => /p9|cookie|csrf|session|token/i.test(name));
console.log('PROBE ' + JSON.stringify({ tried: candidates.size, statuses, names }));
