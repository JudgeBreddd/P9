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

// The arrow's own source, from `const saveConfirm =` to the line that closes it.
const body = client.match(/const saveConfirm = (names => new Promise\(done => \{[\s\S]*?\n\}\));\n/)?.[1];

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
  return { made, saveConfirm: new Function('document', `return ${body};`)(document) };
};

test('O173 A: showSaveConfirm answers the workbench ConfirmResult (0 save, 1 don\'t save, 2 cancel)', async () => {
  assert.ok(body, 'client.js defines saveConfirm as an arrow returning a Promise');
  for (const [value, want] of [['0', 0], ['1', 1], ['2', 2]]) {
    const { made, saveConfirm } = stage();
    const answer = saveConfirm(['notes.md']);
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
  assert.equal(made[0].firstChild.textContent, 'Save changes to 2 files?');
  made[0].click(undefined);
  assert.ok(made[0].open, 'a click outside the buttons does not close it');
  made[0].close();
  assert.equal(await answer, 2);
  console.log('PASS O173A save confirm');
});

test('O173 A: the dialog is installed on the file dialog service, and Revert shows only while the file is dirty', () => {
  assert.match(client, /Object\.defineProperties\(dialogs, \{[\s\S]*?showSaveConfirm: \{ value: saveConfirm \}/);
  assert.ok(body.includes('.textContent = '), 'the file name goes in as text, not markup');
  assert.doesNotMatch(body, /innerHTML[^;]*names/, 'the file name never goes into innerHTML');
  assert.match(client, /registerCommand\('p9\.revert'[\s\S]*?doc\?\.isDirty\) await textFiles\.revert\(URI\.parse\(doc\.uri\.toString\(\)\)\)/);
  assert.match(client, /createStatusBarItem[^;]*;\nObject\.assign\(revert, \{[^}]*command: 'p9\.revert' \}\)/);
  assert.match(client, /const showRevert = \(\) => \{ if \(v\.window\.activeTextEditor\?\.document\.isDirty\) revert\.show\(\); else revert\.hide\(\); \};/);
  for (const event of ['v.window.onDidChangeActiveTextEditor(showRevert)', 'v.workspace.onDidChangeTextDocument(showRevert)', 'v.workspace.onDidSaveTextDocument(showRevert)'])
    assert.ok(client.includes(event), event);
  assert.ok(html.includes('.p9-save-confirm{'), 'index.html styles the dialog');
});
