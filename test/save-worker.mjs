// Faults are installed only in this disposable child, never through the daemon API.
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [workspace, recovery, fault] = process.argv.slice(2);
const originalOpen = fs.open, originalRename = fs.rename, originalUnlink = fs.unlink;
function edit(kind = 'write') {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync, unlinkSync, symlinkSync, renameSync, linkSync } from 'node:fs';
    const [file, kind] = process.argv.slice(1);
    if (kind === 'symlink') { unlinkSync(file); symlinkSync(file + '.outside', file); }
    else if (kind === 'hardlink') linkSync(file, file + '.link');
    else if (kind === 'delete') unlinkSync(file);
    else if (kind === 'replace') { writeFileSync(file + '.agent', 'competing'); renameSync(file + '.agent', file); }
    else writeFileSync(file, 'competing');
  `, path.join(workspace, 'note.txt'), kind]);
}
fs.open = async (...args) => {
  if (fault.startsWith('initial-') && args[0] === workspace) {
    throw Object.assign(new Error('initial target open failed'), { code: fault.slice(8) });
  }
  const handle = await originalOpen(...args);
  if (fault === 'directory-sync' && args[0] === workspace) {
    handle.sync = async () => { throw Object.assign(new Error('I/O'), { code: 'EIO' }); };
  }
  if (String(args[0]).includes('/.p9-save-')) {
    if (fault === 'death-open') process.kill(process.pid, 'SIGKILL');
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (fault === 'full-sync') throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      await sync();
      if (fault === 'death-synced') process.kill(process.pid, 'SIGKILL');
      if (fault === 'move-parent') await fs.rename(workspace, workspace + '-moved');
      if (fault.startsWith('edit-')) edit(fault.slice(5));
    };
    if (fault === 'full-write') handle.writeFile = async () => {
      await handle.write('partial');
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    };
  }
  return handle;
};
fs.rename = async (...args) => {
  if (!String(args[0]).includes('/.p9-save-')) return originalRename(...args);
  if (fault === 'death-before-rename') process.kill(process.pid, 'SIGKILL');
  if (fault === 'late-edit') edit();
  if (fault === 'full-rename') throw Object.assign(new Error('full'), { code: 'ENOSPC' });
  await originalRename(...args);
  if (fault === 'death-after-rename') process.kill(process.pid, 'SIGKILL');
};
fs.unlink = async (...args) => {
  if (fault === 'cleanup-unlink' && String(args[0]).includes('/.p9-conflict-')) {
    throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
  }
  return originalUnlink(...args);
};
if (fault === 'real-full-shared') {
  execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'p9-shared-save-test', path.dirname(workspace)]);
  await fs.mkdir(workspace);
  await fs.mkdir(recovery, { mode: 0o700 });
  await fs.writeFile(path.join(workspace, 'note.txt'), 'original');
  await fs.writeFile(path.join(workspace, 'filler'), Buffer.alloc(900 * 1024));
  const { createListener } = await import('../apps/server/server.mjs');
  const { http, authenticated } = await import('./helpers.mjs');
  const { hash } = await import('../packages/files/index.mjs');
  const credentials = { cookie: 'full-storage-fixture', csrf: 'full-storage-csrf' };
  const server = createListener({ workspace, recovery, credentials, transport: 'unix' });
  const socketPath = path.join(path.dirname(workspace), 'daemon.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    const response = await http({ socketPath, route: '/files', method: 'PUT',
      headers: { ...authenticated(credentials), 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'note.txt', hash: hash('original'), content: 'x'.repeat(256 * 1024) }) });
    console.log(JSON.stringify({ status: response.status, body: JSON.parse(response.text),
      diskContent: await fs.readFile(path.join(workspace, 'note.txt'), 'utf8'),
      sameFilesystem: (await fs.stat(workspace)).dev === (await fs.stat(recovery)).dev,
      recoveryFiles: await fs.readdir(recovery) }));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  process.exit(0);
}
if (fault === 'real-full') {
  execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'p9-save-test', workspace]);
  await fs.writeFile(path.join(workspace, 'note.txt'), 'original');
  await fs.writeFile(path.join(workspace, 'filler'), Buffer.alloc(900 * 1024));
}
syncBuiltinESMExports();
const { guardedSave, hash } = await import('../packages/files/index.mjs');
if (fault === 'cleanup-unlink' || fault.startsWith('initial-')) {
  const { createListener } = await import('../apps/server/server.mjs');
  const { http, authenticated } = await import('./helpers.mjs');
  const credentials = { cookie: 'cleanup-fixture', csrf: 'cleanup-csrf' };
  const server = createListener({ workspace, recovery, credentials, transport: 'unix' });
  const socketPath = path.join(path.dirname(workspace), 'cleanup.sock');
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const response = await http({ socketPath, route: '/files', method: 'PUT',
      headers: { ...authenticated(credentials), 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'note.txt', hash: hash('original'), content: 'user draft' }) });
    if (fault === 'cleanup-unlink' && response.status !== 200) throw new Error(response.text);
    console.log(fault === 'cleanup-unlink' ? response.text
      : JSON.stringify({ status: response.status, body: JSON.parse(response.text) }));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  process.exit(0);
}

const result = await guardedSave(workspace, 'note.txt', hash('original'), fault === 'real-full' ? 'x'.repeat(256 * 1024) : 'user draft', recovery);
console.log(JSON.stringify(fault === 'real-full' ? { ...result, content: undefined,
  diskContent: await fs.readFile(path.join(workspace, 'note.txt'), 'utf8') } : result));
