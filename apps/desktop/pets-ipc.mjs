// Pets: list, petdex import and install, add a folder (IPC handlers). Split out of main.mjs's createDesktop (F9) with no change in behaviour; names that stay in createDesktop come in through outer.
import { ipcMain, app, dialog } from 'electron';
import { loadPet, PET_NAME, addPet } from './pet-files.mjs';
import { readdir, mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function petsIpc(outer) {
  // Pets: no argument lists the usable ones (name and display name only); one argument is a folder name to load.
  ipcMain.handle('p9:pets', async (event, ...args) => {
    if (event.sender !== outer.window.webContents || event.senderFrame !== outer.window.webContents.mainFrame || event.senderFrame.url !== outer.APP_URL
        || args.length > 1) throw new Error('ipc-sender-refused');
    if (args.length) return (await loadPet(outer.petsFolder, args[0])) ?? Promise.reject(new Error('pet-refused'));
    const names = (await readdir(outer.petsFolder).catch(() => [])).filter(name => PET_NAME.test(name)).sort().slice(0, 50);
    const pets = (await Promise.all(names.map(name => loadPet(outer.petsFolder, name)))).filter(Boolean).map(({ name, displayName }) => ({ name, displayName }));
    return { folder: outer.petsFolder, pets, importable: (await importable()).length };
  });
  // Import: Codex's pets folders, names P9 does not have yet; each still goes through addPet's checks on the click. Codex keeps
  // them under CODEX_HOME when it is set, but petdex 1.4.0 always writes ~/.codex/pets (read 2026-11-01), so both are read,
  // CODEX_HOME's first; a name in both comes from CODEX_HOME.
  const petdexFolders = () => [...new Set([process.env.CODEX_HOME && path.join(path.resolve(process.env.CODEX_HOME), 'pets'), path.join(app.getPath('home'), '.codex', 'pets')].filter(Boolean))];
  const importable = async () => {
    const have = new Set(await readdir(outer.petsFolder).catch(() => [])), found = new Map();
    for (const folder of petdexFolders()) {
      for (const name of await readdir(folder).catch(() => [])) if (PET_NAME.test(name) && !have.has(name) && !found.has(name)) found.set(name, path.join(folder, name));
    }
    return [...found.keys()].sort().slice(0, 20).map(name => found.get(name)); // the folders to import
  };
  const addFolders = async folders => {
    const added = [], refused = [];
    for (const folder of folders.slice(0, 20)) {
      const why = await addPet(outer.petsFolder, folder);
      (why ? refused : added).push({ name: path.basename(folder).slice(0, 80), ...(why && { why }) });
    }
    return { added, refused };
  };
  ipcMain.handle('p9:pet-import', async (event, ...args) => {
    if (event.sender !== outer.window.webContents || event.senderFrame !== outer.window.webContents.mainFrame || event.senderFrame.url !== outer.APP_URL
        || args.length) throw new Error('ipc-sender-refused');
    return addFolders(await importable());
  });
  // Install (Builder, 2026-10-18: paste "the npm command from petdex.dev"): the page sends the pasted text; main keeps only the pet
  // names after "install", then does what petdex 1.4.0's install does (read 2026-10-18): petdex.dev's manifest, then the pet's
  // pet.json and sheet from assets.petdex.dev only. Nothing downloaded runs; each pet goes through Add's checks (threat model row 16).
  const getBytes = async (url, max) => {
    const res = await fetch(url, { headers: { Accept: 'application/json, image/*' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok || +res.headers.get('content-length') > max) throw new Error('fetch');
    const bytes = Buffer.from(await res.arrayBuffer()); if (bytes.length > max) throw new Error('fetch'); return bytes;
  };
  const asset = (rel, base) => { const u = new URL(rel, base + '/'); if (u.protocol !== 'https:' || u.hostname !== 'assets.petdex.dev') throw new Error('host'); return u.href; };
  ipcMain.handle('p9:pet-install', async (event, ...args) => {
    if (event.sender !== outer.window.webContents || event.senderFrame !== outer.window.webContents.mainFrame || event.senderFrame.url !== outer.APP_URL
        || args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 300) throw new Error('ipc-sender-refused');
    // The words after the last "install" (or all of them), each a pet name; split, not one regex (a nested one froze main on a long typo).
    const words = args[0].trim().split(/\s+/), tail = words.slice(words.lastIndexOf('install') + 1);
    const names = tail.every(word => PET_NAME.test(word)) ? [...new Set(tail)].slice(0, 5) : [];
    if (!names.length) return { added: [], refused: [{ name: args[0].slice(0, 80), why: 'command' }] };
    let list;
    try { const m = JSON.parse(await getBytes('https://petdex.dev/api/manifest/v2', 16 << 20)); list = m.v === 2 && Array.isArray(m.pets) && m.pets; if (!list) throw 0; asset('', m.assetBase); list.base = m.assetBase; }
    catch { return { added: [], refused: names.map(name => ({ name, why: 'offline' })) }; }
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p9-petdex-')), folders = [], refused = [];
    try {
      for (const name of names) {
        const row = list.find(p => Array.isArray(p) && p[0] === name);
        if (!row) { refused.push({ name, why: 'unknown' }); continue; }
        try {
          const meta = JSON.parse(await getBytes(asset(row[5], list.base), 16 << 10)), sheet = asset(row[4], list.base), ext = path.extname(new URL(sheet).pathname);
          if (!['.webp', '.png'].includes(ext)) throw 0;
          await mkdir(path.join(tmp, name));
          await writeFile(path.join(tmp, name, 'pet.json'), JSON.stringify({ id: String(meta.id ?? name), displayName: String(meta.displayName ?? row[1]), description: String(meta.description ?? ''), spritesheetPath: 'spritesheet' + ext }));
          await writeFile(path.join(tmp, name, 'spritesheet' + ext), await getBytes(sheet, 8 << 20));
          folders.push(path.join(tmp, name));
        } catch (error) { refused.push({ name, why: error?.message === 'host' ? 'invalid' : 'offline' }); }
      }
      const r = await addFolders(folders); r.refused.push(...refused); return r;
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
  // Add: no argument; the user picks folders in the native picker (it opens where the petdex command installs). Remove: one pet name.
  ipcMain.handle('p9:pet-add', async (event, ...args) => {
    if (event.sender !== outer.window.webContents || event.senderFrame !== outer.window.webContents.mainFrame || event.senderFrame.url !== outer.APP_URL
        || args.length) throw new Error('ipc-sender-refused');
    let petdex = app.getPath('home');
    for (const folder of petdexFolders()) if ((await stat(folder).catch(() => null))?.isDirectory()) { petdex = folder; break; }
    const pick = await dialog.showOpenDialog(outer.window, { title: 'Add pets', buttonLabel: 'Add', properties: ['openDirectory', 'multiSelections'],
      defaultPath: petdex });
    return addFolders(pick.canceled ? [] : pick.filePaths);
  });
}
