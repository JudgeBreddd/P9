// Dev Focus's editor server (D5, threat model row 52): install.sh runs this once; Dev Focus's Install button runs the same
// function. An install already on the pinned commit is left alone.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EDITOR_COMMIT, EDITOR_DIR, installEditorHost } from '../apps/desktop/editor-host.mjs';

const host = path.join(EDITOR_DIR, 'codium-server');
const commit = await readFile(path.join(host, 'product.json'), 'utf8').then(text => JSON.parse(text).commit, () => null);
if (commit === EDITOR_COMMIT) console.log('Dev Focus editor server: already installed at ' + host);
else {
  console.log("Dev Focus editor server: downloading VSCodium's REH 1.121.03429 into " + host);
  await installEditorHost();
  console.log('Dev Focus editor server: installed');
}
