// Loaded by with-tmp.mjs into every `node --test` file process (O77): each test file gets its own TMPDIR, removed when
// that file's process exits. with-tmp's one folder was cleared only when the whole run ended, so a full run filled the
// dev space's 1 GiB /tmp (94 false failures on 2813912). Processes a test starts inherit the folder (P9_FILE_TMP) and
// leave it alone; the runner itself (no NODE_TEST_CONTEXT) is untouched.
// The folder sits beside with-tmp's (/tmp/p9-file-XXXXXX), not inside it, so paths stay as long as before: tests that type
// in a shell whose prompt shows the folder (dock-float) wrap the same way as without this preload.
// ponytail: a file process killed hard leaves its folder in /tmp (the dev space's /tmp ends with its container).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.NODE_TEST_CONTEXT && !process.env.P9_FILE_TMP) {
  const dir = mkdtempSync(path.join(path.dirname(os.tmpdir()), 'p9-file-'));
  Object.assign(process.env, { TMPDIR: dir, TEMP: dir, TMP: dir, P9_FILE_TMP: dir });
  process.on('exit', () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
}
