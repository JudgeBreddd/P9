// Pieces over the tunnel: one file carried in base64 pieces, appended only at its exact size so a lost answer resumes
// from the 409's size. The tunnel send (xfer.mjs) uses them; the daemon update (/update/*) is meant to reuse them.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, stat } from 'node:fs/promises';

// Raw bytes a piece: as base64 in JSON it stays well under the daemon's 12 MiB body limit (move.mjs PIECE, same value).
export const PIECE = 4 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

// One piece from an open file handle at `offset`, as move-part answers it.
export async function readPiece(handle, offset) {
  const buffer = Buffer.alloc(PIECE), { bytesRead } = await handle.read(buffer, 0, PIECE, offset);
  return { status: 200, bytes: bytesRead, data: buffer.subarray(0, bytesRead).toString('base64') };
}

export const validPiece = (offset, data) => Number.isSafeInteger(offset) && offset >= 0 && typeof data === 'string'
  && data.length <= Math.ceil(PIECE / 3) * 4 && BASE64.test(data);

// Appends `data` (base64) to `file` when `offset` is its size now. `busy` holds the files mid-append (one writer each).
export async function appendPiece(file, offset, data, max, busy, tooLarge = 'too-large') {
  if (busy.has(file)) return { status: 409, error: 'busy' };
  busy.add(file);
  try {
    const size = (await stat(file).catch(() => null))?.size ?? 0, bytes = Buffer.from(data, 'base64');
    if (offset !== size) return { status: 409, error: 'offset', size };
    if (size + bytes.length > max) return { status: 413, error: tooLarge };
    await appendFile(file, bytes, { mode: 0o600 });
    return { status: 200, size: size + bytes.length };
  } finally { busy.delete(file); }
}

// The staged file is whole: its size and sha256 are the ones the sender named.
export const checkStaged = async (file, bytes, sha256) => ((await stat(file).catch(() => null))?.size ?? 0) === bytes
  && await sha256File(file).catch(() => null) === sha256;
