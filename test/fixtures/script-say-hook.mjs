// O189 test hook (script-say.test.mjs): an approved sprint script that hands the test what P9 put in its environment,
// prints its token (P9 must keep it out of hooks.log), then stays running until the test says go.
import fs from 'node:fs';
fs.writeFileSync('script-env.json', JSON.stringify({ socket: process.env.P9_SCRIPT_SOCKET ?? null, token: process.env.P9_SCRIPT_TOKEN ?? null }));
process.stdout.write('my token is ' + (process.env.P9_SCRIPT_TOKEN ?? 'none') + '\n');
for (let i = 0; i < 1200 && !fs.existsSync('script-go'); i += 1) await new Promise((r) => setTimeout(r, 100));
