import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

// A candidate build (windows-installer.yaml, Run workflow with a version): CI gives that one build the version
// <package.json version>-rc.<n>, with no commit. Installed, a candidate is offered the release it leads to (0.1.5 is newer
// than 0.1.5-rc.1) and never another candidate, since candidates are not published releases. Anything else is refused.
export function candidateVersion(base, wanted) {
  const rc = base + '-rc.';
  if (!/^\d+\.\d+\.\d+$/.test(base) || !wanted.startsWith(rc) || !/^[1-9]\d{0,3}$/.test(wanted.slice(rc.length))) {
    throw new Error(`not-a-candidate: use ${base}-rc.<n>`);
  }
  return wanted;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(candidateVersion(pkg.version, process.argv[2] ?? ''));
}
