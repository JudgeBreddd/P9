// The Windows terminal backend (issue #11 bug 1): a pseudo console (ConPTY, the Windows 10 1809+ API VS Code's
// terminal also uses) driven through node:ffi, so the daemon bundle gains no native addon and no installer files.
// Each terminal is one shell in its own Job Object (Stop ends what it started) attached to a pseudo console whose
// input and output are two named pipes this file creates and Node reads and writes as ordinary async sockets.
// ponytail: node:ffi is experimental in Node 26; the FFI calls here are synchronous but none of them waits on I/O.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
// Loaded, not imported, as in packages/files/win32.mjs: the bundle would hoist a static import above quietFfi (W4).
const ffi = process.getBuiltinModule('node:ffi');

const kernel32 = ffi.dlopen('kernel32.dll', {
  CreateNamedPipeW: { return: 'pointer', arguments: ['buffer', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'pointer'] },
  GetNamedPipeClientProcessId: { return: 'int32', arguments: ['pointer', 'buffer'] },
  // COORD is two SHORTs passed by value: one 32-bit register on x64 and arm64, X (columns) in the low half.
  CreatePseudoConsole: { return: 'int32', arguments: ['uint32', 'pointer', 'pointer', 'uint32', 'buffer'] },
  ResizePseudoConsole: { return: 'int32', arguments: ['pointer', 'uint32'] },
  ClosePseudoConsole: { return: 'void', arguments: ['pointer'] },
  CreateJobObjectW: { return: 'pointer', arguments: ['pointer', 'pointer'] },
  SetInformationJobObject: { return: 'int32', arguments: ['pointer', 'int32', 'buffer', 'uint32'] },
  TerminateJobObject: { return: 'int32', arguments: ['pointer', 'uint32'] },
  InitializeProcThreadAttributeList: { return: 'int32', arguments: ['pointer', 'uint32', 'uint32', 'buffer'] },
  UpdateProcThreadAttribute: { return: 'int32', arguments: ['buffer', 'uint32', 'uint64', 'pointer', 'uint64', 'pointer', 'pointer'] },
  DeleteProcThreadAttributeList: { return: 'void', arguments: ['buffer'] },
  CreateProcessW: { return: 'int32', arguments: ['buffer', 'buffer', 'pointer', 'pointer', 'int32', 'uint32', 'buffer', 'buffer', 'buffer', 'buffer'] },
  WaitForSingleObject: { return: 'uint32', arguments: ['pointer', 'uint32'] },
  CloseHandle: { return: 'int32', arguments: ['pointer'] },
  GetLastError: { return: 'uint32', arguments: [] },
  GetTickCount64: { return: 'uint64', arguments: [] },
}).functions;

const INVALID_HANDLE = 0xffffffffffffffffn;
const PIPE_ACCESS_DUPLEX = 0x3, FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000, PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016n, PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000dn;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_UNICODE_ENVIRONMENT = 0x400, STARTF_USESTDHANDLES = 0x100;
const fail = (operation) => new Error(`${operation} failed (Win32 ${kernel32.GetLastError()})`);
const wide = (text) => Buffer.from(`${text}\0`, 'utf16le');
const coord = (cols, rows) => ((rows & 0xffff) << 16 | (cols & 0xffff)) >>> 0;

// The lease clock (surface 13): milliseconds since boot, counting through sleep, as /proc/uptime does on Linux.
export const boot = () => Number(kernel32.GetTickCount64());

// One pipe end for the pseudo console. The name is random, there is one instance (FIRST_PIPE_INSTANCE, max 1) and
// remote clients are refused; once Node has connected, the client must be this process, so a local process that
// raced in first fails the start instead of reading or typing into the shell.
async function pipe() {
  const name = `\\\\.\\pipe\\p9-pty-${randomUUID()}`;
  const server = kernel32.CreateNamedPipeW(wide(name), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_REJECT_REMOTE_CLIENTS, 1, 0, 0, 0, 0n);
  if (server === INVALID_HANDLE) throw fail('CreateNamedPipeW');
  const socket = net.connect(name);
  try {
    await once(socket, 'connect');
    const pid = Buffer.alloc(4);
    if (!kernel32.GetNamedPipeClientProcessId(server, pid) || pid.readUInt32LE(0) !== process.pid) throw new Error('pty-pipe-client-mismatch');
  } catch (error) { socket.destroy(); kernel32.CloseHandle(server); throw error; }
  return { server, socket };
}

// The shell's environment block: KEY=value pairs sorted case-insensitively, each ending in NUL, then one more NUL.
const environmentBlock = (env) => Buffer.from(Object.entries(env).map(([key, value]) => `${key}=${value}\0`)
  .sort((a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : 1).join('') + '\0', 'utf16le');

function killJob() {
  const job = kernel32.CreateJobObjectW(0n, 0n);
  if (!job) throw fail('CreateJobObjectW');
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes); LimitFlags at 16 = KILL_ON_JOB_CLOSE.
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(0x2000, 16);
  if (!kernel32.SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, limits, limits.length)) { kernel32.CloseHandle(job); throw fail('SetInformationJobObject'); }
  return job;
}

// Starts the shell. Returns { output, resize(cols, rows), write(bytes), exited, kill() }: output is the readable
// socket, exited a promise that settles when the shell has ended, kill() ends the shell and everything it started.
export async function spawnPty({ cwd, env, cols = 80, rows = 24 }) {
  const handles = { pc: 0n, job: 0n, process: 0n, thread: 0n };
  const sockets = [];
  const release = () => {
    for (const key of ['process', 'thread', 'job']) if (handles[key]) { kernel32.CloseHandle(handles[key]); handles[key] = 0n; }
  };
  try {
    const input = await pipe(); sockets.push(input.socket);
    const output = await pipe(); sockets.push(output.socket);
    const pc = Buffer.alloc(8);
    const result = kernel32.CreatePseudoConsole(coord(cols, rows), input.server, output.server, 0, pc);
    // The pseudo console holds its own copies of the pipe handles.
    kernel32.CloseHandle(input.server); kernel32.CloseHandle(output.server);
    if (result !== 0) throw new Error(`CreatePseudoConsole failed (HRESULT 0x${(result >>> 0).toString(16)})`);
    handles.pc = pc.readBigUInt64LE(0);
    handles.job = killJob();

    const size = Buffer.alloc(8);
    kernel32.InitializeProcThreadAttributeList(0n, 2, 0, size);
    const list = Buffer.alloc(Number(size.readBigUInt64LE(0)));
    if (!kernel32.InitializeProcThreadAttributeList(ffi.getRawPointer(list), 2, 0, size)) throw fail('InitializeProcThreadAttributeList');
    // The attribute list keeps pointers to these values until CreateProcessW, so they stay referenced until then.
    const jobs = Buffer.alloc(8);
    jobs.writeBigUInt64LE(handles.job, 0);
    try {
      if (!kernel32.UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, handles.pc, 8n, 0n, 0n)) throw fail('UpdateProcThreadAttribute');
      // The shell starts inside the job, so nothing it starts can run before it is contained.
      if (!kernel32.UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, ffi.getRawPointer(jobs), 8n, 0n, 0n)) throw fail('UpdateProcThreadAttribute');
      // STARTUPINFOEXW: cb, dwFlags at 60, the three std handles at 80-96 left null, lpAttributeList at 104. Null std
      // handles with USESTDHANDLES keep the shell off the daemon's own redirected stdout and stderr.
      const startup = Buffer.alloc(112);
      startup.writeUInt32LE(112, 0);
      startup.writeUInt32LE(STARTF_USESTDHANDLES, 60);
      startup.writeBigUInt64LE(ffi.getRawPointer(list), 104);
      const information = Buffer.alloc(24);
      // Windows PowerShell ships with every Windows P9 supports; the path is fixed, so PATH never picks the shell.
      const shell = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (!kernel32.CreateProcessW(wide(shell), wide(`"${shell}" -NoLogo`), 0n, 0n, 0, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
        environmentBlock(env), wide(cwd), startup, information)) throw fail('CreateProcessW');
      handles.process = information.readBigUInt64LE(0);
      handles.thread = information.readBigUInt64LE(8);
    } finally { kernel32.DeleteProcThreadAttributeList(list); }
  } catch (error) {
    if (handles.job) kernel32.TerminateJobObject(handles.job, 1);
    sockets.forEach((socket) => socket.destroy());
    if (handles.pc) kernel32.ClosePseudoConsole(handles.pc);
    release();
    throw error;
  }

  const [input, output] = sockets;
  input.on('error', () => {}); output.on('error', () => {});
  // The process handle is held until the end, so its ID cannot be reused under us; polled, as there is no async wait.
  // ponytail: up to 500 ms between the shell exiting and the dock hearing it.
  let ended;
  const exited = new Promise((resolve) => { ended = resolve; });
  const poll = setInterval(() => { if (kernel32.WaitForSingleObject(handles.process, 0) === 0) finish(); }, 500);
  poll.unref();
  let finishing = null;
  // The pipes close before ClosePseudoConsole: on Windows before 11 24H2 it waits for its output to be read, and
  // nothing reads it while this synchronous call holds the event loop.
  const finish = () => finishing ??= (async () => {
    clearInterval(poll);
    kernel32.TerminateJobObject(handles.job, 1);
    await Promise.all(sockets.map((socket) => socket.closed ? null : (socket.destroy(), once(socket, 'close'))));
    kernel32.ClosePseudoConsole(handles.pc);
    handles.pc = 0n;
    release();
    ended();
  })();
  return {
    output,
    exited,
    kill: finish,
    // Returns the input the shell has not taken yet, in bytes; the caller bounds it.
    write: (bytes) => { if (!finishing) input.write(bytes); return input.writableLength; },
    resize: (cols, rows) => { if (handles.pc) kernel32.ResizePseudoConsole(handles.pc, coord(cols, rows)); },
  };
}
