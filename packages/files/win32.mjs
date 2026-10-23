// The Windows form of the file guard's walk. Linux anchors every step on /proc/self/fd with O_NOFOLLOW; Windows has
// neither, so each component opens with NtCreateFile relative to its parent's handle and FILE_OPEN_REPARSE_POINT
// (a junction or symlink opens as itself and is refused), and the opened handle's final path must be the expected one
// (this also refuses case and 8.3 short-name variants). Reads, writes, renames and deletes go through the same handles.
// ponytail: node:ffi is experimental in Node 26.10 and these calls are synchronous; files are capped at MAX_BYTES (2 MiB).
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Loaded here, not imported: the installed daemon is one bundle (bundle-daemon.mjs), which hoists a static import to its top,
// before index.mjs's quietFfi could drop the experimental warning (W4).
const ffi = process.getBuiltinModule('node:ffi');

const kernel32 = ffi.dlopen('kernel32.dll', {
  CreateFileW: { return: 'pointer', arguments: ['buffer', 'uint32', 'uint32', 'pointer', 'uint32', 'uint32', 'pointer'] },
  GetFinalPathNameByHandleW: { return: 'uint32', arguments: ['pointer', 'buffer', 'uint32', 'uint32'] },
  GetFileInformationByHandle: { return: 'int32', arguments: ['pointer', 'buffer'] },
  GetFileInformationByHandleEx: { return: 'int32', arguments: ['pointer', 'int32', 'buffer', 'uint32'] },
  GetVolumeInformationByHandleW: { return: 'int32', arguments: ['pointer', 'pointer', 'uint32', 'pointer', 'pointer', 'pointer', 'buffer', 'uint32'] },
  FlushFileBuffers: { return: 'int32', arguments: ['pointer'] },
  CloseHandle: { return: 'int32', arguments: ['pointer'] },
  GetCurrentProcess: { return: 'pointer', arguments: [] },
  GetLastError: { return: 'uint32', arguments: [] },
}).functions;
const advapi32 = ffi.dlopen('advapi32.dll', {
  OpenProcessToken: { return: 'int32', arguments: ['pointer', 'uint32', 'buffer'] },
  GetTokenInformation: { return: 'int32', arguments: ['pointer', 'int32', 'buffer', 'uint32', 'buffer'] },
}).functions;
const ntdll = ffi.dlopen('ntdll.dll', {
  NtCreateFile: { return: 'int32', arguments: ['buffer', 'uint32', 'buffer', 'buffer', 'pointer', 'uint32', 'uint32', 'uint32', 'uint32', 'pointer', 'uint32'] },
  NtSetInformationFile: { return: 'int32', arguments: ['pointer', 'buffer', 'buffer', 'uint32', 'int32'] },
  // Status and byte count come back together, so EOF and errors do not depend on a later GetLastError call.
  NtReadFile: { return: 'int32', arguments: ['pointer', 'pointer', 'pointer', 'pointer', 'buffer', 'buffer', 'uint32', 'buffer', 'pointer'] },
  NtWriteFile: { return: 'int32', arguments: ['pointer', 'pointer', 'pointer', 'pointer', 'buffer', 'buffer', 'uint32', 'buffer', 'pointer'] },
  NtQueryDirectoryFile: { return: 'int32', arguments: ['pointer', 'pointer', 'pointer', 'pointer', 'buffer', 'buffer', 'uint32', 'int32', 'uint8', 'pointer', 'uint8'] },
  NtQuerySecurityObject: { return: 'int32', arguments: ['pointer', 'uint32', 'buffer', 'uint32', 'buffer'] },
  NtSetSecurityObject: { return: 'int32', arguments: ['pointer', 'uint32', 'buffer'] },
}).functions;

const INVALID_HANDLE = 0xffffffffffffffffn;
const SYNCHRONIZE = 0x00100000, DELETE = 0x00010000, READ_CONTROL = 0x00020000;
const FILE_GENERIC_READ = 0x00120089, FILE_GENERIC_WRITE = 0x00120116;
// Read-only: NTFS checks create and rename against the folder's own ACL, not the RootDirectory handle's access.
const DIRECTORY_ACCESS = 0x0001 /* list */ | 0x0020 /* traverse */ | 0x0080 /* read attributes */ | SYNCHRONIZE | READ_CONTROL;
const SHARE_ALL = 7, SHARE_READ = 1, FILE_OPEN = 1, FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x1, FILE_NON_DIRECTORY_FILE = 0x40, FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_OPEN_REPARSE_POINT = 0x00200000;
const ATTRIBUTE_DIRECTORY = 0x10, ATTRIBUTE_REPARSE = 0x400;
const FileRenameInformationEx = 65, FileDispositionInformationEx = 64, FileFullDirectoryInformation = 2, FileIdInfo = 18;
const STATUS_NO_MORE_FILES = 0x80000006 | 0;

// NTSTATUS → the errno codes the shared code and the API already map (index.mjs isPathConflict, server.mjs onError).
const STATUS = { 0xc0000034: 'ENOENT', 0xc000003a: 'ENOENT', 0xc0000033: 'ENOENT', 0xc0000056: 'ENOENT', 0xc0000035: 'EEXIST',
  0xc0000022: 'EACCES', 0xc0000103: 'ENOTDIR', 0xc000007f: 'ENOSPC', 0xc0000043: 'EBUSY', 0xc0000044: 'EDQUOT',
  0xc0000054: 'EBUSY' /* lock conflict */, 0xc000005a: 'EPERM' /* invalid owner: the target's owner cannot be restored */, 0xc000005b: 'EPERM' /* invalid primary group, likewise */, 0xc00000a2: 'EROFS' /* write-protected */, 0xc0000121: 'EACCES' /* cannot delete: read-only */ };
const fail = (code, operation) => Object.assign(new Error(`${code}: ${operation}`), { code });
const statusError = (status, operation) => {
  const unsigned = status >>> 0;
  if (unsigned === 0xc00000ba) return new Error('unsafe-file'); // FILE_IS_A_DIRECTORY: Linux reaches the same refusal via stat
  return fail(STATUS[unsigned] ?? 'EIO', `${operation} (NTSTATUS 0x${unsigned.toString(16)})`);
};
const lastError = (operation) => {
  const error = kernel32.GetLastError();
  return fail({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 32: 'EBUSY', 112: 'ENOSPC', 183: 'EEXIST' }[error] ?? 'EIO', `${operation} (Win32 ${error})`);
};

const wide = (text) => Buffer.from(`${text}\0`, 'utf16le');
// GetFinalPathNameByHandleW returns \\?\C:\… or \\?\UNC\server\…; the daemon's roots come from realpath, which gives C:\… or \\server\….
function finalPath(handle) {
  const buffer = Buffer.alloc(65536);
  const length = kernel32.GetFinalPathNameByHandleW(handle, buffer, 32767, 0);
  if (!length || length >= 32767) throw lastError('GetFinalPathNameByHandleW');
  const text = buffer.toString('utf16le', 0, length * 2);
  return text.startsWith('\\\\?\\UNC\\') ? `\\\\${text.slice(8)}` : text.startsWith('\\\\?\\') ? text.slice(4) : text;
}
function fileSystem(handle) {
  const name = Buffer.alloc(522);
  if (!kernel32.GetVolumeInformationByHandleW(handle, 0n, 0, 0n, 0n, 0n, name, 261)) throw lastError('GetVolumeInformationByHandleW');
  return name.toString('utf16le').replace(/\0.*$/s, '');
}
const filetimeMs = (buffer, offset) => Number((buffer.readBigUInt64LE(offset) - 116444736000000000n) / 10000n);
function information(handle) {
  const buffer = Buffer.alloc(52);
  if (!kernel32.GetFileInformationByHandle(handle, buffer)) throw lastError('GetFileInformationByHandle');
  const attributes = buffer.readUInt32LE(0);
  const fileTime = Buffer.alloc(8);
  buffer.copy(fileTime, 0, 20, 28);
  // The 64-bit volume serial and 128-bit id: the legacy 64-bit index is not unique on ReFS. Only a FAT-family volume,
  // which has no FileIdInfo, falls back to the legacy pair (unique there); any other failure fails closed.
  const id = Buffer.alloc(24);
  const full = kernel32.GetFileInformationByHandleEx(handle, FileIdInfo, id, 24);
  if (!full && !/^(FAT|FAT32|exFAT)$/i.test(fileSystem(handle))) throw fail('EIO', 'FileIdInfo unavailable');
  return {
    attributes,
    dev: full ? id.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(28)),
    ino: full ? (id.readBigUInt64LE(16) << 64n) | id.readBigUInt64LE(8) : (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48)),
    size: buffer.readUInt32LE(32) * 2 ** 32 + buffer.readUInt32LE(36), nlink: buffer.readUInt32LE(40), mtimeMs: filetimeMs(fileTime, 0),
    // No POSIX mode on Windows; the shared save copies mode & 0o777 only through chmod, which is a no-op here.
    mode: 0o600,
    isFile: () => (attributes & (ATTRIBUTE_DIRECTORY | ATTRIBUTE_REPARSE)) === 0,
    isDirectory: () => (attributes & (ATTRIBUTE_DIRECTORY | ATTRIBUTE_REPARSE)) === ATTRIBUTE_DIRECTORY,
  };
}

class Handle {
  constructor(handle) { this.handle = handle; }
  stat() { return Promise.resolve(information(this.handle)); }
  async read(buffer, offset, length, position) {
    const view = Buffer.alloc(length), status = Buffer.alloc(16), at = Buffer.alloc(8);
    at.writeBigUInt64LE(BigInt(position), 0);
    const result = ntdll.NtReadFile(this.handle, 0n, 0n, 0n, status, view, length, at, 0n);
    if (result === (0xc0000011 | 0)) return { bytesRead: 0 }; // STATUS_END_OF_FILE
    if (result !== 0) throw statusError(result, 'NtReadFile');
    const bytesRead = Number(status.readBigUInt64LE(8)); // IO_STATUS_BLOCK.Information
    view.copy(buffer, offset, 0, bytesRead);
    return { bytesRead };
  }
  async writeFile(content) {
    const data = Buffer.from(content);
    for (let offset = 0; offset < data.length;) {
      const status = Buffer.alloc(16), at = Buffer.alloc(8), chunk = data.subarray(offset, offset + 1024 * 1024);
      at.writeBigUInt64LE(BigInt(offset), 0);
      const result = ntdll.NtWriteFile(this.handle, 0n, 0n, 0n, status, chunk, chunk.length, at, 0n);
      if (result !== 0) throw statusError(result, 'NtWriteFile');
      offset += Number(status.readBigUInt64LE(8));
    }
  }
  async chmod() {}
  async sync() {
    // Directories too: the rename is not durable until the folder's metadata is flushed. A failure here leaves the
    // save as durability-uncertain with its draft kept (index.mjs), never as saved.
    // Walk handles are read-only, so a directory reopens itself (empty name relative to its own handle) to flush.
    const target = this.directory ? openRelative(this, '', { access: 0x0002 /* add file: write on a directory */, options: FILE_DIRECTORY_FILE }) : this;
    try { if (!kernel32.FlushFileBuffers(target.handle)) throw lastError('FlushFileBuffers'); }
    finally { if (target !== this) await target.close(); }
  }
  async close() {
    if (this.handle === undefined) return;
    kernel32.CloseHandle(this.handle);
    this.handle = undefined;
  }
}

// Buffers reached only through a raw pointer inside another struct; a module write keeps them alive across the call.
let pinned = null;
// Closes the handle when a check after the open throws.
function checked(handle, check) {
  try { return check(); } catch (error) { kernel32.CloseHandle(handle); throw error; }
}

function openRelative(parent, name, { access, disposition = FILE_OPEN, options, share = SHARE_ALL, security }) {
  const out = Buffer.alloc(8), status = Buffer.alloc(16), nameBuffer = Buffer.from(name, 'utf16le');
  if (nameBuffer.length > 0xfffe) throw new Error('locked-path');
  const unicode = Buffer.alloc(16);
  unicode.writeUInt16LE(nameBuffer.length, 0);
  unicode.writeUInt16LE(nameBuffer.length, 2);
  unicode.writeBigUInt64LE(nameBuffer.length ? ffi.getRawPointer(nameBuffer) : 0n, 8); // empty: the RootDirectory itself
  const attributes = Buffer.alloc(48);
  attributes.writeUInt32LE(48, 0);
  attributes.writeBigUInt64LE(BigInt(parent.handle), 8);
  attributes.writeBigUInt64LE(ffi.getRawPointer(unicode), 16);
  // Case-sensitive lookup is not available per call on a normal NTFS directory; the final-path check refuses variants.
  attributes.writeUInt32LE(0x40 /* OBJ_CASE_INSENSITIVE */, 24);
  if (security) attributes.writeBigUInt64LE(ffi.getRawPointer(security), 32); // only used when the file is created
  pinned = [nameBuffer, unicode, security];
  let result;
  try {
    result = ntdll.NtCreateFile(out, access | SYNCHRONIZE | 0x0080 /* read attributes, for the reparse check */, attributes, status, 0n, 0, share, disposition,
      options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, 0n, 0);
  } finally { pinned = null; }
  if (result > 0) kernel32.CloseHandle(out.readBigUInt64LE(0)); // an informational status still opened a handle
  if (result !== 0) throw statusError(result, `NtCreateFile(${name})`);
  const handle = new Handle(out.readBigUInt64LE(0));
  return checked(handle.handle, () => {
    if (information(handle.handle).attributes & ATTRIBUTE_REPARSE) throw fail('ELOOP', `reparse point: ${name}`);
    return handle;
  });
}

function openDirectoryPath(directory) {
  // \\?\ lifts the 260-character limit; the roots are canonical already, so nothing relies on Win32 normalisation.
  const long = directory.startsWith('\\\\') ? `\\\\?\\UNC\\${directory.slice(2)}` : `\\\\?\\${directory}`;
  const handle = kernel32.CreateFileW(wide(long), DIRECTORY_ACCESS, SHARE_ALL, 0n, 3 /* OPEN_EXISTING */,
    0x02000000 /* BACKUP_SEMANTICS */ | 0x00200000 /* OPEN_REPARSE_POINT */, 0n);
  if (handle === INVALID_HANDLE) throw lastError(`CreateFileW(${directory})`);
  const result = new Handle(handle);
  result.directory = true;
  return checked(handle, () => {
    const info = information(handle);
    if (!info.isDirectory()) throw fail(info.attributes & ATTRIBUTE_REPARSE ? 'ELOOP' : 'ENOTDIR', directory);
    return result;
  });
}
const openDirectory = (parent, name) => {
  const handle = openRelative(parent, name, { access: DIRECTORY_ACCESS, options: FILE_DIRECTORY_FILE });
  handle.directory = true;
  return handle;
};

// Linux: open(root, O_DIRECTORY|O_NOFOLLOW) and realpath(/proc/self/fd/N) === root.
export function openRoot(root) {
  const handle = openDirectoryPath(root);
  return checked(handle.handle, () => {
    if (finalPath(handle.handle) !== root) throw new Error('path-changed');
    return handle;
  });
}

export async function resolveSafe(root, parts, maxBytes) {
  const handles = [];
  try {
    let parent = openRoot(root);
    handles.push(parent);
    for (const part of parts.slice(0, -1)) { parent = openDirectory(parent, part); handles.push(parent); }
    const file = openRelative(parent, parts.at(-1), { access: FILE_GENERIC_READ, options: FILE_NON_DIRECTORY_FILE });
    handles.push(file);
    const stat = information(file.handle);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('unsafe-file');
    if (finalPath(file.handle) !== path.join(root, ...parts)) throw new Error('path-changed');
    return { file, parent, stat, anchored: parts.at(-1), close: () => Promise.all(handles.map((handle) => handle.close())) };
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}

export async function listDirectory(root, parts, locked) {
  const handles = [];
  try {
    let parent = openRoot(root);
    handles.push(parent);
    for (const part of parts) { parent = openDirectory(parent, part); handles.push(parent); }
    if (finalPath(parent.handle) !== path.join(root, ...parts)) throw new Error('path-changed');
    const entries = [];
    const buffer = Buffer.alloc(64 * 1024);
    // NtQueryDirectoryFile returns the end-of-listing status directly, so a failure cannot pass as the end of the list.
    for (let restart = 1; ; restart = 0) {
      const result = ntdll.NtQueryDirectoryFile(parent.handle, 0n, 0n, 0n, Buffer.alloc(16), buffer, buffer.length, FileFullDirectoryInformation, 0, 0n, restart);
      if (result === STATUS_NO_MORE_FILES) break;
      if (result !== 0) throw statusError(result, 'NtQueryDirectoryFile');
      for (let offset = 0; ;) {
        const next = buffer.readUInt32LE(offset), attributes = buffer.readUInt32LE(offset + 56);
        const name = buffer.toString('utf16le', offset + 68, offset + 68 + buffer.readUInt32LE(offset + 60));
        // Reparse points are left out, as Linux's lstat leaves out symlinks.
        if (name !== '.' && name !== '..' && !locked(name) && !(attributes & ATTRIBUTE_REPARSE)) {
          entries.push({ name, mtimeMs: filetimeMs(buffer, offset + 24), ...(attributes & ATTRIBUTE_DIRECTORY ? { dir: true } : {}) });
        }
        if (!next) break;
        offset += next;
      }
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
}

// Linux: createFile's walk, then open(`/proc/self/fd/N/name`, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW). FILE_CREATE fails
// when the name exists, so a new file never replaces one.
export async function createNamed(root, parts) {
  const handles = [];
  try {
    let parent = openRoot(root);
    handles.push(parent);
    for (const part of parts.slice(0, -1)) { parent = openDirectory(parent, part); handles.push(parent); }
    if (finalPath(parent.handle) !== path.join(root, ...parts.slice(0, -1))) throw new Error('path-changed');
    const name = parts.at(-1);
    const file = stage(parent, name, openRelative(parent, name, { access: FILE_GENERIC_WRITE | DELETE, disposition: FILE_CREATE,
      options: FILE_NON_DIRECTORY_FILE, share: SHARE_READ }));
    return { file, parent, close: async () => { await takeStaged(parent, name)?.release(); await Promise.all(handles.map((handle) => handle.close())); } };
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close()));
    throw error;
  }
}

// Linux: createDirectory's walk, then mkdir. FILE_CREATE fails with EEXIST when the name exists, a link included.
export async function createDirectory(root, parts) {
  const handles = [];
  try {
    let parent = openRoot(root);
    handles.push(parent);
    for (const part of parts.slice(0, -1)) { parent = openDirectory(parent, part); handles.push(parent); }
    if (finalPath(parent.handle) !== path.join(root, ...parts.slice(0, -1))) throw new Error('path-changed');
    handles.push(openRelative(parent, parts.at(-1), { access: DIRECTORY_ACCESS, disposition: FILE_CREATE, options: FILE_DIRECTORY_FILE }));
  } finally { await Promise.all(handles.map((handle) => handle.close())); }
}

// Files the guard creates stay open from creation to their rename or delete, without write or delete sharing, so no
// other process can change, move or swap them in between; renameAt and unlinkAt then act through this handle rather than
// reopening the name. The shared code's close() is deferred to that point (or to createNamed's close).
const staged = new Map();
const stagedKey = (parent, name) => `${parent.handle}\0${name}`;
function stage(parent, name, handle) {
  staged.set(stagedKey(parent, name), handle);
  handle.release = handle.close;
  handle.close = async () => {};
  return handle;
}
function takeStaged(parent, name) {
  const key = stagedKey(parent, name), handle = staged.get(key);
  staged.delete(key);
  return handle;
}

// The token's user SID (TokenUser). Not its default owner: that can be BUILTIN\Administrators (Sol round 4 High 1),
// which would let every admin open a draft through OWNER RIGHTS.
let user;
function tokenUser() {
  if (user) return user;
  const token = Buffer.alloc(8), info = Buffer.alloc(256), length = Buffer.alloc(4);
  if (!advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008 /* TOKEN_QUERY */, token)) throw lastError('OpenProcessToken');
  const handle = token.readBigUInt64LE(0);
  try { if (!advapi32.GetTokenInformation(handle, 1 /* TokenUser */, info, info.length, length)) throw lastError('GetTokenInformation'); }
  finally { kernel32.CloseHandle(handle); }
  const offset = Number(info.readBigUInt64LE(0) - ffi.getRawPointer(info)); // TOKEN_USER.User.Sid points into info
  return (user = Buffer.from(info.subarray(offset, offset + 8 + 4 * info[offset + 1])));
}
// A self-relative security descriptor: owner = the token user, protected DACL (nothing inherited from the folder) with
// one ACE giving that user full access. No one else can open the temp until matchSecurity gives it the target's.
function userOnly() {
  const sid = tokenUser(), ace = 8 + sid.length, acl = 8 + ace, descriptor = Buffer.alloc(20 + sid.length + acl);
  descriptor[0] = 1;
  descriptor.writeUInt16LE(0x9004 /* SELF_RELATIVE | DACL_PROTECTED | DACL_PRESENT */, 2);
  descriptor.writeUInt32LE(20, 4); // owner
  descriptor.writeUInt32LE(20 + sid.length, 16); // DACL
  sid.copy(descriptor, 20);
  const at = 20 + sid.length;
  descriptor[at] = 2; // ACL revision
  descriptor.writeUInt16LE(acl, at + 2);
  descriptor.writeUInt16LE(1, at + 4); // one ACE: ACCESS_ALLOWED, FILE_ALL_ACCESS, the user's SID
  descriptor.writeUInt16LE(ace, at + 10);
  descriptor.writeUInt32LE(0x001f01ff, at + 12);
  sid.copy(descriptor, at + 16);
  return descriptor;
}
const WRITE_DAC = 0x00040000, WRITE_OWNER = 0x00080000, SE_DACL_PROTECTED = 0x1000;
const OWNER_GROUP_DACL = 1 | 2 | 4; // OWNER | GROUP | DACL_SECURITY_INFORMATION
function descriptorOf(handle, information) {
  const security = Buffer.alloc(65536);
  const result = ntdll.NtQuerySecurityObject(handle.handle, information, security, security.length, Buffer.alloc(4));
  if (result !== 0) throw statusError(result, 'NtQuerySecurityObject');
  return security;
}
// The owner and primary-group SIDs, the DACL's protected flag and its ACEs, as one comparable key.
const sidHex = (security, at) => (at ? security.toString('hex', at, at + 8 + 4 * security[at + 1]) : 'null');
function ownerGroupDacl(handle) {
  const security = descriptorOf(handle, OWNER_GROUP_DACL);
  const offset = security.readUInt32LE(16), control = security.readUInt16LE(2);
  return { security, key: `${sidHex(security, security.readUInt32LE(4))}:${sidHex(security, security.readUInt32LE(8))}:${control & SE_DACL_PROTECTED}:`
    + `${offset ? security.toString('hex', offset, offset + security.readUInt16LE(offset + 2)) : 'null'}` };
}
// Sol round 4 High 2: a temp-then-rename save cannot carry EFS encryption (the new file would be plaintext), a
// mandatory label, resource attributes or named streams over to the new file. Such a target fails closed (EPERM,
// draft kept) rather than losing them. ponytail: refuse, not preserve; a Zone.Identifier stream refuses too.
function refuseUnkept(file) {
  if (information(file.handle).attributes & 0x4000 /* FILE_ATTRIBUTE_ENCRYPTED */) throw fail('EPERM', 'encrypted file');
  const sacl = descriptorOf(file, 0x10 | 0x20 | 0x40 /* LABEL | ATTRIBUTE | SCOPE: readable with READ_CONTROL */), offset = sacl.readUInt32LE(12);
  if (offset && sacl.readUInt16LE(offset + 4)) throw fail('EPERM', 'labelled file');
  const streams = Buffer.alloc(65536);
  if (!kernel32.GetFileInformationByHandleEx(file.handle, 7 /* FileStreamInfo */, streams, streams.length)) {
    if (/^(FAT|FAT32|exFAT)$/i.test(fileSystem(file.handle))) return; // no streams there
    throw lastError('FileStreamInfo');
  }
  if (streams.readUInt32LE(0) !== 0) throw fail('EPERM', 'named streams'); // NextEntryOffset: more than ::$DATA
}

// Linux: open(`/proc/self/fd/N/.p9-…`, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600), then chmod to the target's mode.
// `like` (the file being replaced) marks a save temp: it starts owned by and open only to the token user, so the
// draft is never readable by anyone the original did not allow, and gets the target's owner and DACL from
// matchSecurity just before the rename (Sol round 3 H1: a DACL supplied at creation was merged with the folder's
// inheritable ACEs and went stale if the target was tightened; round 4 High 1: owner). A save temp shares nothing
// (Sol round 7 High 1): while matchSecurity gives it a DACL that may already be stale, no one else can open it.
export function createExclusive(parent, prefix, like) {
  const name = `${prefix}${randomUUID()}`;
  return { name, file: stage(parent, name, openRelative(parent, name, { access: FILE_GENERIC_WRITE | DELETE | (like ? WRITE_DAC | WRITE_OWNER | 0x0080 /* FILE_READ_ATTRIBUTES: refuseUnkept */ : 0),
    disposition: FILE_CREATE, options: FILE_NON_DIRECTORY_FILE, share: like ? 0 : SHARE_READ, security: like ? userOnly() : undefined })) };
}

// Gives the temp the target's current owner, primary group and DACL (same ACEs, same protected flag) and checks them
// back. False when the result differs or the target's changed meanwhile: the caller reports a conflict instead of
// publishing. An owner or group this user cannot assign and a target with metadata the save would lose throw EPERM.
// Order (Sol round 6): the temp and the target are both checked before the temp's DACL is widened, so a draft never
// becomes readable to users the target kept out (an EFS target), nor is a temp that inherited EFS or a label from its
// folder published over a plain target; the target is checked once more after the final descriptor reads.
// Stated limits: the checks are separate queries, so a stream, label or EFS change racing with them can still be
// lost (closing that needs an oplock, finding #6); and the target's audit SACL and SACL protection cannot be read
// without SeSecurityPrivilege, which P9's limited token never has, so they are neither compared nor kept, and the
// saved file gets whatever audit SACL Windows gave the temp on creation (inherited from the folder).
export function matchSecurity(temporary, latest) {
  refuseUnkept(temporary);
  refuseUnkept(latest);
  const wanted = ownerGroupDacl(latest);
  const control = wanted.security.readUInt16LE(2);
  // An auto-inherited DACL (AI) is only kept when the new descriptor asks for it (SE_DACL_AUTO_INHERIT_REQ).
  if (control & 0x0400 /* SE_DACL_AUTO_INHERITED */) wanted.security.writeUInt16LE(control | 0x0100, 2);
  const result = ntdll.NtSetSecurityObject(temporary.handle, OWNER_GROUP_DACL, wanted.security);
  if (result !== 0) throw statusError(result, 'NtSetSecurityObject');
  const same = ownerGroupDacl(temporary).key === wanted.key && ownerGroupDacl(latest).key === wanted.key;
  refuseUnkept(latest);
  return same;
}

// ntdll directly: kernel32's SetFileInformationByHandle resolves a bare rename target against the process's current
// directory (seen on the Windows desktop 2026-10-17: the file left its folder for the cwd), so it cannot anchor on the parent.
function setInformation(handle, infoClass, buffer, operation) {
  const result = ntdll.NtSetInformationFile(handle.handle, Buffer.alloc(16), buffer, buffer.length, infoClass);
  if (result !== 0) throw statusError(result, operation);
}

// Linux: rename(`/proc/self/fd/N/from`, `/proc/self/fd/N/to`). RootDirectory = the parent handle anchors the target the
// same way the opens are anchored. POSIX semantics replace a target that is open with FILE_SHARE_DELETE (the guard's
// own read handles).
// Every rename source is a staged handle. Only deletes of a name the guard no longer holds reach the open below,
// which are a finished draft record or a temp file already gone. ponytail: that open keeps delete sharing; without it,
// the delete hit sharing violations on the Windows desktop (2026-10-17, likely a scanner holding the fresh record). So a same-user
// process could move the record away between this open and the delete, which it could equally delete itself.
const openSource = (parent, name) => takeStaged(parent, name)
  ?? openRelative(parent, name, { access: DELETE, options: FILE_NON_DIRECTORY_FILE });
const done = async (parent, name, handle, ok) => {
  if (!handle.release) return handle.close();
  if (ok) return handle.release();
  staged.set(stagedKey(parent, name), handle); // a failed rename leaves the file staged for the caller's unlinkAt
};
export async function renameAt(parent, from, to) {
  // The recovery folder keeps holding a draft record after its rename (Sol round 3 M1), so draft.remove() deletes the
  // record it wrote, by handle. The record it replaces is let go first: a held name cannot be renamed over.
  if (parent.keep) await takeStaged(parent, to)?.release();
  const source = openSource(parent, from);
  let ok = false;
  try {
    const name = Buffer.from(to, 'utf16le'), info = Buffer.alloc(24 + name.length);
    info.writeUInt32LE(0x1 /* REPLACE_IF_EXISTS */ | 0x2 /* POSIX_SEMANTICS */, 0);
    info.writeBigUInt64LE(BigInt(parent.handle), 8);
    info.writeUInt32LE(name.length, 16);
    name.copy(info, 20);
    setInformation(source, FileRenameInformationEx, info, `rename(${from})`);
    ok = true;
    if (parent.keep && source.release) { staged.set(stagedKey(parent, to), source); return; }
  } finally { if (!(ok && parent.keep && source.release)) await done(parent, from, source, ok); }
}

// Linux: unlink(`/proc/self/fd/N/name`).
export async function unlinkAt(parent, name) {
  const target = openSource(parent, name);
  try {
    const info = Buffer.alloc(4);
    info.writeUInt32LE(0x1 /* DELETE */ | 0x2 /* POSIX_SEMANTICS */, 0);
    setInformation(target, FileDispositionInformationEx, info, `unlink(${name})`);
  } finally { await done(parent, name, target, true); }
}

// The recovery directory: opened without following a final reparse point. Its owner-only ACL is the installer's job on
// Windows, as main.mjs already decides for the state and ownership directories; the outside-the-workspace check stays.
export function openRecovery(recovery) {
  const directory = openDirectoryPath(recovery), close = directory.close.bind(directory), prefix = `${directory.handle}\0`;
  directory.keep = true;
  directory.close = async () => {
    for (const [key, handle] of staged) if (key.startsWith(prefix)) { staged.delete(key); await handle.release(); }
    await close();
  };
  return directory;
}
export const canonical = (handle) => finalPath(handle.handle);
