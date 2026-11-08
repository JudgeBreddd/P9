// Pet folders on disk: the name and sheet checks, reading one pet and adding a folder of them. Split out of main.mjs (F9) with no change in behaviour.
import { lstat, open, mkdir, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const PET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/, PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Agent-working pets (threat model row 16): a petdex folder under <profile>/pets, read as plain files only (never a link),
// pet.json up to 16 KB, the spritesheet a bare .webp/.png name up to 8 MB with a matching signature, handed over as a data URL.
export async function readPlain(file, max) {
  if ((await lstat(file)).isSymbolicLink()) throw new Error('pet-refused'); // Windows has no O_NOFOLLOW
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('pet-refused');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function readPet(pets, name) {
  if (typeof name !== 'string' || !PET_NAME.test(name)) return null;
  try {
    const folder = path.join(pets, name);
    if (!(await lstat(folder)).isDirectory()) return null;
    const meta = JSON.parse(await readPlain(path.join(folder, 'pet.json'), 16384));
    const file = meta?.spritesheetPath;
    if (typeof meta?.id !== 'string' || typeof meta.displayName !== 'string' || typeof file !== 'string'
        || file.startsWith('.') || !/^[\w.-]{1,128}\.(?:webp|png)$/i.test(file)) return null;
    const bytes = await readPlain(path.join(folder, file), 8 << 20);
    const type = bytes.subarray(0, 8).equals(PNG) ? 'png' : bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : null;
    return type && { meta, file, bytes, type };
  } catch { return null; }
}
export async function loadPet(pets, name) {
  const pet = await readPet(pets, name);
  return pet && { name, displayName: pet.meta.displayName.slice(0, 80), sprite: `data:image/${pet.type};base64,` + pet.bytes.toString('base64') };
}
// Adding copies a checked pet out of a folder the user picked: a rewritten pet.json and the sheet bytes, never over an existing pet.
export async function addPet(pets, folder) {
  const name = path.basename(folder), pet = await readPet(path.dirname(folder), name);
  if (!PET_NAME.test(name)) return 'name';
  if (!pet) return 'invalid';
  const target = path.join(pets, name), { id, displayName, description = '', spritesheetPath } = pet.meta;
  await mkdir(pets, { recursive: true });
  try { await mkdir(target); } catch (error) { return error.code === 'EEXIST' ? 'exists' : 'invalid'; }
  try {
    await writeFile(path.join(target, 'pet.json'), JSON.stringify({ id, displayName, description: String(description).slice(0, 1000), spritesheetPath }, null, 2) + '\n');
    await writeFile(path.join(target, spritesheetPath), pet.bytes);
  } catch { await rm(target, { recursive: true, force: true }); return 'invalid'; }
  return null;
}
