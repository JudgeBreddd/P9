import test from 'node:test';
import assert from 'node:assert/strict';
import * as folder from '../apps/desktop/dev-folder.mjs';
import { failedReply } from '../scripts/teh.mjs';

const { serverPath, folderError, trusted, setTrust } = folder;
// main's side of openFolder, faked: each call is logged in calls; replies come from the options.
function side({ server = null, workspace = '/w', picked = '/w', found, set = { status: 200, body: { root: '/x' } }, loose = false, trustAll = false, answer = { response: 1, checkboxChecked: false }, folder: open = null, platform = 'linux' } = {}) {
  const calls = [];
  const o = {
    server, failedReply, platform, sep: '/', folder: open,
    health: async () => (calls.push(['health']), workspace === null ? null : { workspace }),
    request: async (method, path, body) => { calls.push(['request', method, path, body]); if (body.check) { if (found instanceof Error) throw found; return found; } return body.path === null ? { status: 200, body: { root: null } } : set; },
    realpath: async p => p, pick: async options => (calls.push(['pick', options]), picked === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [picked] }),
    ask: async options => (calls.push(['ask', options]), answer), loose: async () => (calls.push(['loose']), loose), trustAll: async () => trustAll,
    trust: async on => calls.push(['trust', on]), setFolder: next => calls.push(['setFolder', next]), reopen: () => calls.push(['reopen']),
  };
  return { o, calls, kinds: () => calls.map(c => c[0]) };
}

// Dev Focus Open Folder in Server mode (threat model rows 41/50 adds): main asks for the server path instead of refusing, checks
// it with the server's rules, and every refusal names its own reason.
test('Dev Focus Open Folder in Server mode: a typed server path, the server\'s real path decides inside or outside, and the real reason on a refusal', { timeout: 10000 }, async () => {
  const open = (options, ...args) => { const fake = side({ server: 'srv', ...options }); return folder.openFolder?.(fake.o, args).then(reply => ({ reply, ...fake })); };
  // No path yet: the page is asked for one (Server mode is not refused as daemon-unavailable); the open folder, else the workspace.
  assert.deepEqual((await open({})).reply, { pathNeeded: true, value: '/w' }, 'Server mode asks the page for the server path');
  assert.deepEqual((await open({ folder: { path: '/srv/o', outside: true } })).reply, { pathNeeded: true, value: '/srv/o' });
  // The typed path is checked with the server's rules before anything is asked of the daemon.
  let r = await open({}, 'srv/rel');
  assert.deepEqual(r.reply, { error: 'path-not-absolute', server: true });
  assert.deepEqual(r.kinds(), ['health']);
  // Inside or outside is the server's answer on the real path: a link in the workspace that points outside asks first.
  r = await open({ found: { status: 200, body: { workspace: '/srv/w', root: '/srv/w/sub' } } }, '/srv/w/x/../sub/');
  assert.deepEqual(r.calls[1], ['request', 'POST', '/dev/root', { path: '/srv/w/sub', check: true }], 'the normalised path, check only');
  assert.deepEqual(r.reply, { ok: true });
  assert.deepEqual(r.calls.slice(2), [['setFolder', { path: '/srv/w/sub', outside: false, tail: '/sub' }], ['reopen']], 'inside: no ask, no set');
  r = await open({ found: { status: 200, body: { workspace: '/srv/w', root: '/srv/data' } }, set: { status: 200, body: { root: '/srv/data' } } }, '/srv/w/link');
  assert.equal(r.calls.find(c => c[0] === 'ask')[1].message, 'Open /srv/data on srv in Dev Focus?', 'the real path, on the server');
  assert.deepEqual(r.calls.at(-3), ['request', 'POST', '/dev/root', { path: '/srv/data' }]);
  // Each refusal keeps its own reason; an old server's request-refused reads as daemon-outdated; no reply is daemon-unavailable.
  for (const [found, error] of [[{ status: 404, body: { error: 'root-not-found' } }, 'root-not-found'], [{ status: 403, body: { error: 'root-refused' } }, 'root-refused'],
    [{ status: 400, body: { error: 'request-refused' } }, 'daemon-outdated'], [{ status: 500, body: {} }, 'daemon-unavailable'], [new Error('down'), 'daemon-unavailable']]) {
    r = await open({ found }, '/srv/x');
    assert.deepEqual(r.reply, { error, server: true }, error);
    assert.ok(!r.kinds().includes('setFolder') && !r.kinds().includes('reopen'), 'a refusal changes nothing');
  }
  assert.deepEqual((await open({ workspace: null }, '/srv/x')).reply, { error: 'daemon-unavailable', server: true }, 'no daemon');

  assert.deepEqual(serverPath('/srv/work/src/'), { real: '/srv/work/src' });
  assert.deepEqual(serverPath(' /srv/work '), { real: '/srv/work' });
  assert.deepEqual(serverPath('/srv/work/../other/./x'), { real: '/srv/other/x' });
  assert.equal(serverPath('/srv/work/src/../../../etc').real, '/etc');
  for (const bad of ['srv/work', 'C:\\work', '~/work']) assert.deepEqual(serverPath(bad), { error: 'path-not-absolute' });
  for (const bad of ['', '  ', null, 7, '/a\0b', '/' + 'a'.repeat(4096)]) assert.deepEqual(serverPath(bad), { error: 'request-refused' });

  const words = ['root-refused', 'root-not-found', 'path-not-absolute', 'request-refused', 'daemon-unavailable', 'daemon-outdated'].map(e => folderError(e, true));
  assert.equal(new Set(words).size, words.length, 'each reason has its own words');
  assert.match(folderError('root-not-found', true), /on the server/);
  assert.match(folderError('root-refused', true), /Turn on Unrestricted mode in Settings on the server to open it/, 'v0.1.6 U1: the refusal says how to open home');
  assert.match(folderError('daemon-unavailable', true), /server/);
  assert.doesNotMatch(folderError('daemon-unavailable', false), /server/);
  assert.match(folderError('inside-workspace', true), /\(inside-workspace\)/, 'an unknown reason is still named');
});

// v0.1.6 U2 (threat model row 41): outside the workspace, Unrestricted mode asks "Trust this folder?" with a "Don't ask again"
// box, kept as one global flag and honoured only while the mode is on; with it off, the old confirm, word for word.
test('U2: Trust this folder? with Don\'t ask again, only in Unrestricted mode', { timeout: 10000 }, async () => {
  // The mode is the daemon's predicate: both switches off. Anything else, or no answer, is off and drops the flag (L4).
  for (const [lock, files, want] of [[false, false, true], [true, false, false], [false, true, false], [undefined, false, false]]) {
    const dropped = [];
    const loose = await folder.unrestricted?.(async p => ({ body: { on: p === '/agent-lock' ? lock : files } }), async () => dropped.push(true));
    assert.equal(loose, want, `lock ${lock}, files ${files}`);
    assert.deepEqual(dropped, want ? [] : [true], 'L4: the mode off drops the flag');
  }
  const gone = [];
  assert.equal(await folder.unrestricted?.(async () => { throw new Error('down'); }, async () => gone.push(true)), false, 'no daemon reads as off');
  assert.deepEqual(gone, [true]);
  // Outside the workspace on this computer: the mode decides which ask, and the flag skips it only while the mode is on.
  const open = (options) => { const fake = side({ picked: '/x', ...options }); return folder.openFolder?.(fake.o, []).then(reply => ({ reply, ...fake })); };
  let r = await open({});
  const warning = r.calls.find(c => c[0] === 'ask')[1];
  assert.deepEqual([warning.type, warning.title, warning.message, warning.buttons, warning.defaultId, warning.checkboxLabel], ['warning', 'Open a folder outside the workspace?', 'Open /x in Dev Focus?', ['Cancel', 'Open folder'], 0, undefined], 'mode off: the old confirm');
  assert.deepEqual(r.reply, { ok: true });
  assert.deepEqual(r.calls.slice(-3), [['request', 'POST', '/dev/root', { path: '/x' }], ['setFolder', { path: '/x', outside: true, tail: '' }], ['reopen']], 'the daemon\'s spelling of the root is kept');
  assert.ok(!r.kinds().includes('trust'));
  r = await open({ trustAll: true });
  assert.ok(r.kinds().includes('ask') && !r.kinds().includes('trust'), 'mode off: a kept flag does not skip the ask');
  r = await open({ loose: true, answer: { response: 1, checkboxChecked: true } });
  const question = r.calls.find(c => c[0] === 'ask')[1];
  assert.deepEqual([question.type, question.title, question.message, question.checkboxLabel, question.checkboxChecked], ['question', 'Trust this folder?', 'Trust /x and open it in Dev Focus?', 'Don\'t ask again', false]);
  assert.ok(r.kinds().indexOf('trust') < r.kinds().indexOf('request'), 'the box ticked: kept before the open');
  assert.deepEqual(r.calls.find(c => c[0] === 'trust'), ['trust', true]);
  r = await open({ loose: true });
  assert.ok(!r.kinds().includes('trust'), 'the box left clear: nothing kept');
  r = await open({ loose: true, trustAll: true });
  assert.ok(!r.kinds().includes('ask') && r.kinds().includes('request'), 'mode on and the flag kept: no ask');
  for (const loose of [false, true]) {
    r = await open({ loose, answer: { response: 0, checkboxChecked: true } });
    assert.deepEqual(r.reply, { ok: false }, 'Cancel');
    assert.ok(!['request', 'setFolder', 'reopen', 'trust'].some(k => r.kinds().includes(k)), 'Cancel changes nothing, keeps nothing');
  }
  r = await open({ set: { status: 403, body: { error: 'root-refused' } } });
  assert.deepEqual(r.reply, { error: 'root-refused', server: false });
  assert.ok(!r.kinds().includes('setFolder'), 'a refused root is not opened');
  // Inside: no ask; an open outside root is unset at the daemon first; the workspace itself is no folder at all.
  r = await open({ picked: '/w/src', folder: { path: '/x', outside: true } });
  assert.deepEqual(r.calls.slice(-3), [['request', 'POST', '/dev/root', { path: null }], ['setFolder', { path: '/w/src', outside: false, tail: '/src' }], ['reopen']]);
  assert.ok(!r.kinds().includes('loose'), 'inside never asks the mode');
  assert.deepEqual((await open({ picked: '/w' })).calls.slice(-2), [['setFolder', null], ['reopen']]);
  assert.deepEqual((await open({ picked: '/wider' })).calls.find(c => c[0] === 'ask')?.[1].message, 'Open /wider in Dev Focus?', 'a sibling with the same prefix is outside');
  assert.equal((await open({ picked: '/W/Src', platform: 'win32' })).kinds().includes('ask'), false, 'Windows compares without case');
  assert.equal((await open({ picked: '/W/Src' })).kinds().includes('ask'), true, 'elsewhere case counts');
  r = await open({ picked: null });
  assert.deepEqual(r.reply, { ok: false }, 'the picker cancelled');
  assert.ok(!r.kinds().includes('setFolder') && !r.kinds().includes('reopen'));
  assert.equal((await open({ folder: { path: '/x/old' } })).calls.find(c => c[0] === 'pick')[1].defaultPath, '/x/old', 'the picker starts at the open folder');
  // L4: per place; mode off drops only that place; the old global flag trusts nowhere.
  let file = setTrust('', 'local', true);
  assert.deepEqual([trusted(file, 'local'), trusted(file, 'server-a')], [true, false]);
  file = setTrust(file, 'server-a', true);
  assert.equal(setTrust(file, 'server-a', true), null, 'no change, no write');
  file = setTrust(file, 'local', false);
  assert.deepEqual([trusted(file, 'local'), trusted(file, 'server-a')], [false, true]);
  assert.equal(trusted(JSON.stringify({ trustOutside: true }), 'local'), false);
  assert.equal(trusted('not json', 'local'), false);
  // U4: the chat folder picker: inside is relative; outside only for a new chat in the mode; Setup's picks never outside.
  const asked = [];
  const pickFolder = (real, setup, loose) => folder.chatFolder?.('/w', real, '/', setup, async () => (asked.push(real), loose));
  assert.equal(await pickFolder('/w', false, false), '');
  assert.equal(await pickFolder('/w/a/b', true, false), 'a/b');
  assert.equal(await pickFolder('/wider', false, false), null, 'a sibling with the same prefix is outside');
  assert.equal(await pickFolder('/x', false, true), '/x', 'U4: an outside chat folder in the mode');
  assert.equal(await pickFolder('/x', false, false), null, 'not without it');
  assert.equal(await pickFolder('/x', true, true), null, 'only for a new chat');
  assert.equal(await pickFolder(null, false, true), null, 'a folder gone since');
  assert.deepEqual(asked, ['/wider', '/x', '/x'], 'the mode is asked only for a new chat\'s outside folder');
  console.log('PASS U2: Trust this folder? with Don\'t ask again in the mode, the old confirm without it; U4 picker gated the same way');
});
