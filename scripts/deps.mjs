// Item 15 (v0.1.6 c13, threat model row 61): install.sh's dependency check, at install and at every update. Prints what
// this machine still needs, each with the reason, and never runs sudo itself: install.sh shows this, asks, then runs
// the --command line.
//   node scripts/deps.mjs [--headless]             the missing ones with their reasons; exit 3 if P9 cannot run without one
//   node scripts/deps.mjs [--headless] --command   the one command that installs them all (needs the admin password)
//   --update: an existing install; the window's needs count when this clone has an Electron (a headless one has none)
import { dependencies, packageManager } from '../apps/server/deps.mjs';

const headless = process.argv.includes('--headless');
const manager = await packageManager();
// A new install runs this before pnpm install, so there is no Electron yet: a desktop install asks for the window's
// needs up front.
const desktop = headless ? false : process.argv.includes('--update') ? undefined : true;
const missing = (await dependencies({ manager, desktop })).filter((dependency) => dependency.admin);
// ssh is for Server mode and Send to server only; everything else here stops P9 (tmux) or its window (sandbox).
const required = missing.filter((dependency) => dependency.id !== 'ssh');

if (process.argv.includes('--command')) {
  const packages = missing.filter((dependency) => dependency.package).map((dependency) => dependency.package);
  const commands = [...packages.length ? [manager.command + ' ' + packages.join(' ')] : [],
    ...missing.filter((dependency) => !dependency.package && dependency.command).map((dependency) => dependency.command)];
  if (commands.length) console.log(commands.join(' && '));
} else {
  for (const dependency of missing) {
    console.log(`- ${dependency.id}: ${dependency.why}` + (dependency.command ? '' : ' Install it with your package manager.'));
  }
  // 3, not 1: install.sh tells "P9 cannot run without these" (3) from the check itself failing (any other code).
  process.exitCode = required.length ? 3 : 0;
}
