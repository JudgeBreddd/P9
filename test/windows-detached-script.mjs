import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 300000)'], { detached: true, stdio: 'ignore' });
child.unref();
process.stdout.write(`detach:${child.pid}\n`);
setInterval(() => {}, 300000);
