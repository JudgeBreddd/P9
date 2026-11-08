// A file's security descriptor as SDDL text, read in this process (advapi32 through node:ffi) instead of from a
// powershell.exe Get-Acl: on GitHub's windows-11-arm runner each powershell.exe start took 16-20 s, which made the file
// guard tests 12 minutes there against 16 s on x64 (0.1.8 F1). Same text as (Get-Acl).Sddl: owner, group and DACL
// (Get-Acl's .NET form calls this same Win32 conversion). files-windows.test.mjs checks the two agree once.
import { execFileSync } from 'node:child_process';

let api;
function load() {
  if (api) return api;
  const ffi = process.getBuiltinModule('node:ffi');
  const advapi32 = ffi.dlopen('advapi32.dll', {
    GetFileSecurityW: { return: 'int32', arguments: ['buffer', 'uint32', 'buffer', 'uint32', 'buffer'] },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { return: 'int32', arguments: ['pointer', 'uint32', 'uint32', 'buffer', 'buffer'] },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { return: 'int32', arguments: ['buffer', 'uint32', 'buffer', 'buffer'] },
  }).functions;
  const kernel32 = ffi.dlopen('kernel32.dll', {
    lstrcpynW: { return: 'pointer', arguments: ['buffer', 'pointer', 'int32'] },
    LocalFree: { return: 'pointer', arguments: ['pointer'] },
    GetLastError: { return: 'uint32', arguments: [] },
  }).functions;
  return (api = { ffi, advapi32, kernel32 });
}
const OWNER_GROUP_DACL = 1 | 2 | 4;
const wide = (text) => Buffer.from(`${text}\0`, 'utf16le');

// The descriptor at a pointer as SDDL text (the string LocalAlloc'd by Windows is copied out, then freed).
function toSddl(descriptor, what) {
  const { advapi32, kernel32 } = load();
  const out = Buffer.alloc(8), length = Buffer.alloc(4);
  if (!advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, what, out, length)) {
    throw new Error(`ConvertSecurityDescriptorToStringSecurityDescriptorW (Win32 ${kernel32.GetLastError()})`);
  }
  const text = out.readBigUInt64LE(0), chars = length.readUInt32LE(0) + 1, copy = Buffer.alloc(chars * 2);
  try { kernel32.lstrcpynW(copy, text, chars); } finally { kernel32.LocalFree(text); }
  return copy.toString('utf16le').split('\0')[0];
}

export function sddl(file) {
  const { ffi, advapi32, kernel32 } = load();
  const descriptor = Buffer.alloc(65536), needed = Buffer.alloc(4);
  if (!advapi32.GetFileSecurityW(wide(file), OWNER_GROUP_DACL, descriptor, descriptor.length, needed)) {
    throw new Error(`GetFileSecurityW ${file} (Win32 ${kernel32.GetLastError()})`);
  }
  return toSddl(ffi.getRawPointer(descriptor), OWNER_GROUP_DACL);
}

// The token user as SDDL text writes it: the SID, or an alias such as LA for the built-in Administrator (RID 500, the
// GitHub Windows runner's account). whoami gives the SID; a round trip through a descriptor gives SDDL's form of it.
let user;
export function userSid() {
  if (user) return user;
  const { advapi32, kernel32 } = load();
  const sid = /S-1-[\d-]+/.exec(execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }))[0];
  const out = Buffer.alloc(8), size = Buffer.alloc(4);
  if (!advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(`O:${sid}`), 1, out, size)) {
    throw new Error(`ConvertStringSecurityDescriptorToSecurityDescriptorW (Win32 ${kernel32.GetLastError()})`);
  }
  const descriptor = out.readBigUInt64LE(0);
  try { return (user = toSddl(descriptor, 1).slice(2)); } finally { kernel32.LocalFree(descriptor); }
}
