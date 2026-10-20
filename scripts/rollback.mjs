// Roll P9's state back to the copy taken before the last schema migration. Stop the daemon first.
// Usage: node scripts/rollback.mjs [--state-home <dir>]   (default ~/.local/state/p9-foundation)
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { rollbackLedger } from '../apps/server/ledger.mjs';

const { values } = parseArgs({ options: { 'state-home': { type: 'string' } } });
const home = values['state-home'] ?? path.join(os.homedir(), '.local', 'state', 'p9-foundation');
if (process.platform === 'linux' && !values['state-home']) {
  let active = '';
  try { active = execFileSync('systemctl', ['--user', 'is-active', 'p9-foundation.service'], { encoding: 'utf8' }).trim(); } catch {}
  if (active === 'active') { console.error('Stop the daemon first: systemctl --user stop p9-foundation.service'); process.exit(2); }
}
let used;
try { used = rollbackLedger(path.join(home, 'p9.db')); }
catch (error) { if (!error.current) throw error; console.error(error.message); process.exit(1); }
if (!used) { console.error('No pre-migration backup in ' + home + '; nothing rolled back.'); process.exit(1); }
console.log('P9_ROLLED_BACK from ' + used);
