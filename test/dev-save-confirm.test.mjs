// O173 A: closing a dirty tab in the dev editor asks Save / Don't Save / Cancel, and a Revert button is in sight.
// A source check only: the dev space cannot run this editor (O77), so nothing here opens the workbench. It runs the
// saveConfirm arrow from client.js against a stand-in <dialog> to hold the answer mapping, and reads the wiring around it.
// What it does not hold: that the workbench really calls showSaveConfirm on close, that a real <dialog> shows and takes
// focus, or that Revert really reloads the tab. the owner checks those on the next nightly (O173v).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './helpers.mjs';

const client = await readFile(path.join(root, 'apps/dev/client.js'), 'utf8');
const html = await readFile(path.join(root, 'apps/dev/index.html'), 'utf8');

// saveConfirm's own source (with the queue line before it, if there is one), from `const saveConfirm =` to the first
// unindented line that closes it.
const body = client.match(/((?:let confirming = Promise\.resolve\(\);\n)?const saveConfirm = names => [\s\S]*?\n\}\)?;)\n/)?.[1];
const tick = () => new Promise(next => setImmediate(next));

// A stand-in for the browser's <dialog>: close(value) sets returnValue and fires close, like the real one.
const stage = () => {
  const made = [];
  const document = {
    body: { append: box => { box.attached = true; } },
    querySelector: () => null,
    createElement: () => {
      const on = {}, buttons = [];
      const box = {
        returnValue: '', open: false, attached: false, firstChild: { textContent: '' },
        set innerHTML(markup) { for (const [, value, label] of markup.matchAll(/<button value="(\d)">([^<]*)</g)) buttons.push({ value, label, focus() { box.focused = this; } }); },
        addEventListener: (name, fn) => { on[name] = fn; },
        showModal() { box.open = true; },
        querySelector: () => buttons[0],
        remove() { box.attached = false; },
        close(value) { if (value !== undefined) box.returnValue = value; box.open = false; on.close?.(); },
        click: value => on.click({ target: buttons.find(b => b.value === value) ?? {} }),
        buttons,
      };
      made.push(box);
      return box;
    },
  };
  return { made, saveConfirm: new Function('document', `${body}\nreturn saveConfirm;`)(document) };
};

test('O173 A: showSaveConfirm answers the workbench ConfirmResult (0 save, 1 don\'t save, 2 cancel)', async () => {
  assert.ok(body, 'client.js defines saveConfirm as an arrow returning a Promise');
  for (const [value, want] of [['0', 0], ['1', 1], ['2', 2]]) {
    const { made, saveConfirm } = stage();
    const answer = saveConfirm(['notes.md']);
    await tick();
    const box = made[0];
    assert.ok(box.open && box.attached, 'the dialog is shown as a modal');
    assert.deepEqual(box.buttons.map(b => b.label), ['Save', "Don't Save", 'Cancel']);
    assert.equal(box.focused, box.buttons[0], 'Save has focus, so Enter saves');
    assert.equal(box.firstChild.textContent, 'Save changes to notes.md?');
    box.click(value);
    assert.equal(await answer, want);
    assert.ok(!box.attached, 'the dialog is removed after the choice');
  }
  // Escape closes a <dialog> with no returnValue: that is Cancel, so the draft stays open.
  const { made, saveConfirm } = stage();
  const answer = saveConfirm(['a.js', 'b.js']);
  await tick();
  assert.equal(made[0].firstChild.textContent, 'Save changes to 2 files?');
  made[0].click(undefined);
  assert.ok(made[0].open, 'a click outside the buttons does not close it');
  made[0].close();
  assert.equal(await answer, 2);
  console.log('PASS O173A save confirm');
});

test('O173 A: two close requests show one dialog at a time, each with its own file and its own answer', async () => {
  const { made, saveConfirm } = stage();
  const first = saveConfirm(['a.js']), second = saveConfirm(['b.js']);
  await tick();
  assert.equal(made.filter(box => box.attached).length, 1, 'only one dialog is in the document');
  assert.equal(made[0].firstChild.textContent, 'Save changes to a.js?');
  made[0].click('1');
  assert.equal(await first, 1, "the first answer is Don't Save");
  await tick();
  assert.equal(made.filter(box => box.attached).length, 1, 'the second dialog shows only after the first is answered');
  assert.equal(made[1].firstChild.textContent, 'Save changes to b.js?', 'the second dialog names its own file');
  made[1].close();
  assert.equal(await second, 2, 'the second gets its own answer (Escape = Cancel), not the first one');
  assert.equal(made.length, 2);
  console.log('PASS O173A one at a time');
});

test('O173 A: the dialog is installed on the file dialog service, and Revert shows only while the file is dirty', () => {
  assert.match(client, /Object\.defineProperties\(dialogs, \{[\s\S]*?showSaveConfirm: \{ value: saveConfirm \}/);
  assert.ok(body.includes('.textContent = '), 'the file name goes in as text, not markup');
  assert.doesNotMatch(body, /innerHTML[^;]*names/, 'the file name never goes into innerHTML');
  assert.match(client, /registerCommand\('p9\.revert'[\s\S]*?doc\?\.isDirty\) await textFiles\.revert\(URI\.parse\(doc\.uri\.toString\(\)\)\)/);
  assert.match(client, /createStatusBarItem[^;]*;\nObject\.assign\(revert, \{[^}]*command: 'p9\.revert' \}\)/);
  assert.match(client, /const showRevert = \(\) => \{ if \(v\.window\.activeTextEditor\?\.document\.isDirty\) revert\.show\(\); else revert\.hide\(\); \};/);
  for (const event of ['v.window.onDidChangeActiveTextEditor(showRevert)', 'v.workspace.onDidChangeTextDocument(showRevert)', 'v.workspace.onDidSaveTextDocument(showRevert);\nshowRevert();'])
    assert.ok(client.includes(event), event);
  assert.ok(html.includes('.p9-save-confirm{'), 'index.html styles the dialog');
});
