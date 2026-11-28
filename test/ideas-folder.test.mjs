import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated } from './helpers.mjs';

// GitHub issue #572 (O299): + New idea writes to the workspace's _ideas/. A workspace that keeps it one folder down
// (notes/_ideas, with the workspace one folder above) has the one found there used; two found are named, not guessed.
const idea = (instance, name) => http({ socketPath: instance.credentials.socketPath, route: '/mission/idea', method: 'POST',
  headers: { ...authenticated(instance.credentials), 'content-type': 'application/json' }, body: JSON.stringify({ name, text: 'x', needs_done: false }) })
  .then((r) => ({ status: r.status, body: JSON.parse(r.text) }));
const folders = (...list) => async ({ workspace }) => { for (const f of list) await mkdir(path.join(workspace, f), { recursive: true }); return {}; };

test('New idea: _ideas at the root, else the one _ideas one folder down; none or two answer 404 naming them', { timeout: 60000 }, async (t) => {
  const top = await daemon(t, undefined, false, folders('_ideas', 'notes/_ideas'));
  const root = await idea(top, 'at root');
  assert.deepEqual([root.status, root.body?.path], [201, '_ideas/at-root.md']);

  const down = await daemon(t, undefined, false, folders('notes/_ideas/needs-done', 'other'));
  const made = await idea(down, 'one down');
  assert.deepEqual([made.status, made.body?.path], [201, 'notes/_ideas/one-down.md']);
  assert.equal(await readFile(path.join(down.workspace, 'notes/_ideas/one-down.md'), 'utf8'), 'x\n');

  const two = await daemon(t, undefined, false, folders('a/_ideas', 'b/_ideas'));
  const refused = await idea(two, 'which');
  assert.equal(refused.status, 404); assert.match(refused.body?.error ?? '', /a\/_ideas, b\/_ideas/);

  // #579 r1: a folder the writer refuses never counts: a root _ideas that is a link, a link one folder down, a locked folder's (secrets), an archive's.
  const links = await daemon(t, undefined, false, async ({ workspace }) => {
    await folders('notes/_ideas', 'elsewhere', 'secrets/_ideas', '_archive/_ideas', 'b')({ workspace });
    await symlink(path.join(workspace, 'elsewhere'), path.join(workspace, '_ideas'));
    await symlink(path.join(workspace, 'elsewhere'), path.join(workspace, 'b/_ideas'));
    return {};
  });
  const skipped = await idea(links, 'skips links');
  assert.deepEqual([skipped.status, skipped.body?.path], [201, 'notes/_ideas/skips-links.md']);

  // #579 r2: a folder whose name the writer refuses (':' is not allowed in a path) neither counts nor is picked alone.
  // ponytail: Linux and macOS only; Windows cannot make the folder, and the writer's rule is the same code there.
  if (process.platform !== 'win32') {
    const colon = await daemon(t, undefined, false, folders('notes/_ideas', 'Upcoming: ideas/_ideas'));
    const picked = await idea(colon, 'beside colon');
    assert.deepEqual([picked.status, picked.body?.path], [201, 'notes/_ideas/beside-colon.md']);
    const alone = await daemon(t, undefined, false, folders('Upcoming: ideas/_ideas'));
    const refusedAlone = await idea(alone, 'colon alone');
    assert.deepEqual([refusedAlone.status, refusedAlone.body?.error], [404, 'no _ideas folder']);
  }

  const none = await daemon(t, undefined, false, folders('a'));
  const nowhere = await idea(none, 'nowhere');
  assert.deepEqual([nowhere.status, nowhere.body?.error], [404, 'no _ideas folder']);
  console.log('PASS new idea finds _ideas one folder down');
});
