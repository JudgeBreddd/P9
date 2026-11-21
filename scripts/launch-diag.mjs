// Loaded by with-tmp.mjs into every `node --test` file process on Linux (O58 diagnostic, 2026-11-21). CI has had Electron
// fail to start with "Missing X server or $DISPLAY" while the X server stayed up (O58 (k), (m); O4b), and the log could
// not say why. When _electron.launch throws, this prints what the X side looked like at that moment, then throws the
// same error: no retry, no change to a launch that works.
// ponytail: imports @playwright/test into every test file process, used or not (one module load each).
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const run = (file, args, env) => {
  try { return { code: 0, out: execFileSync(file, args, { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (error) { return { code: error.status ?? error.code ?? error.signal, out: (error.stdout || '') + (error.stderr || '') }; }
};

// Connect to the display's socket as an X client would (no xdpyinfo needed): 'connected', or the error code.
const connect = (display) => new Promise((resolve) => {
  const n = /^:(\d+)/.exec(display ?? '')?.[1];
  if (!n) return resolve('no local display number in DISPLAY');
  const socket = net.connect('/tmp/.X11-unix/X' + n);
  socket.setTimeout(3000, () => { socket.destroy(); resolve('timed out after 3 s'); });
  socket.once('connect', () => { socket.destroy(); resolve('connected'); });
  socket.once('error', (error) => resolve(error.code ?? error.message));
});

// What one failed launch saw: the DISPLAY it was given and this process's, the X sockets, and whether a client connects now.
export async function xState(env = process.env) {
  const ls = run('ls', ['-la', '/tmp/.X11-unix'], env);
  const xdpy = run('xdpyinfo', [], env);
  return ['O58 launch-diag: electron.launch failed',
    `DISPLAY=${env.DISPLAY ?? '(unset)'} (this process: ${process.env.DISPLAY ?? '(unset)'}) XAUTHORITY=${env.XAUTHORITY ?? '(unset)'}`,
    `ls -la /tmp/.X11-unix (exit ${ls.code}):`, ls.out.trimEnd(),
    `xdpyinfo exit ${xdpy.code}${xdpy.code ? ': ' + xdpy.out.trim().split('\n')[0] : ''}`,
    `socket /tmp/.X11-unix/X<n> for that DISPLAY: ${await connect(env.DISPLAY)}`].join('\n');
}

if (process.env.NODE_TEST_CONTEXT && process.platform === 'linux') {
  const { _electron } = await import('@playwright/test');
  const launch = _electron.launch.bind(_electron);
  _electron.launch = async (options) => {
    try { return await launch(options); }
    catch (error) { console.error(await xState(options?.env ?? process.env).catch((e) => 'O58 launch-diag failed: ' + e)); throw error; }
  };
}
