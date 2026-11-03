import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newer } from '../server/update.mjs';

// D13: the version this profile ran before this start, so the window can say what an update brought. p9-version.txt holds
// the last version that started. Nothing wrote it before 0.1.6, so a profile that already has a desktop's files but no
// p9-version.txt was updated from an older one ('' then). A fresh profile, the same version again, or a rollback to an
// older version: null. The file is written either way.
const BEFORE = ['p9-settings.json', 'update-state.json', 'p9-update.log'];
export function updatedFrom(profile, version) {
  const file = path.join(profile, 'p9-version.txt');
  let seen = null;
  try { seen = readFileSync(file, 'utf8').trim(); } catch {}
  const older = seen === null && BEFORE.some((name) => existsSync(path.join(profile, name)));
  try { writeFileSync(file, version); } catch {}
  if (older) return '';
  return seen && newer(version, seen) ? seen : null;
}
