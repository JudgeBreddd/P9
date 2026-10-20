// A disk-sync barrier in a disposable real daemon; no production fault controls.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const originalOpen = fs.open;
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (String(args[0]).includes('/.p9-save-')) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await new Promise((resolve) => {
        process.once('message', resolve);
        process.send('save-paused');
      });
      await sync();
    };
  }
  return handle;
};
syncBuiltinESMExports();
process.on('SIGTERM', () => process.send('signal-seen'));
await import('../apps/server/main.mjs');
