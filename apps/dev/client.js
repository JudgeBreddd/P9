// Dev Focus: Monaco + VS Code services (the phase-2 editor, docs/spike-decision.md) against the desktop's loopback editor host.
// Every write P9's editor makes inside the workspace goes through window.p9dev.save, which the desktop sends to the daemon's
// guarded save (packages/files). Writes extensions, terminals or language servers make on the host are "runs as you, not guarded".
import { initialize, getService, IFileService, IThemeService, IExtensionService, ITextFileService, IFileDialogService } from '@codingame/monaco-vscode-api';
import getWorkbench from '@codingame/monaco-vscode-workbench-service-override';
import getModel from '@codingame/monaco-vscode-model-service-override';
import getAuthentication from '@codingame/monaco-vscode-authentication-service-override';
import getTesting from '@codingame/monaco-vscode-testing-service-override';
import getTask from '@codingame/monaco-vscode-task-service-override';
import getGallery from '@codingame/monaco-vscode-extension-gallery-service-override';
import { createIndexedDBProviders } from '@codingame/monaco-vscode-files-service-override';
import getConfiguration, { initUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override';
import getExtensions from '@codingame/monaco-vscode-extensions-service-override';
import getRemote from '@codingame/monaco-vscode-remote-agent-service-override';
import getSearch from '@codingame/monaco-vscode-search-service-override';
import getTerminal from '@codingame/monaco-vscode-terminal-service-override';
import getScm from '@codingame/monaco-vscode-scm-service-override';
import getDebug from '@codingame/monaco-vscode-debug-service-override';
import getStorage from '@codingame/monaco-vscode-storage-service-override';
import getWorkingCopy from '@codingame/monaco-vscode-working-copy-service-override';
import getKeybindings from '@codingame/monaco-vscode-keybindings-service-override';
import getTextmate from '@codingame/monaco-vscode-textmate-service-override';
import getLanguages from '@codingame/monaco-vscode-languages-service-override';
import getTheme from '@codingame/monaco-vscode-theme-service-override';
import getNotifications from '@codingame/monaco-vscode-notifications-service-override';
import getOutput from '@codingame/monaco-vscode-output-service-override';
import getTrust from '@codingame/monaco-vscode-workspace-trust-service-override';
import getExplorer from '@codingame/monaco-vscode-explorer-service-override';
import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { RemoteFileSystemProviderClient } from '@codingame/monaco-vscode-remote-agent-service-override/vscode/vs/workbench/services/remote/common/remoteFileSystemProviderClient';
import 'vscode/localExtensionHost';
import '@codingame/monaco-vscode-theme-defaults-default-extension';
import '@codingame/monaco-vscode-typescript-basics-default-extension';
import '@codingame/monaco-vscode-python-default-extension';
import EditorWorker from '@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker?worker';
import TextmateWorker from '@codingame/monaco-vscode-textmate-service-override/worker?worker';

const status = document.querySelector('#status');
const config = await window.p9dev.config();
if (config.error) { status.textContent = 'Dev Focus is unavailable: ' + config.error; throw new Error(config.error); }
window.MonacoEnvironment = { getWorker: (_, label) => (label === 'TextMateWorker' ? new TextmateWorker() : new EditorWorker()) };
const authority = '127.0.0.1:' + config.port;
// Windows: remote URIs carry C:\Users\x as /c:/Users/x, and the REH and the workbench do not agree on the drive letter's
// case. Paths are compared in URI form with it lower-cased, and handed to main as Windows paths again.
const win = /^[A-Za-z]:\\/.test(config.workspace);
const uriPath = file => (win ? '/' + file.replaceAll('\\', '/') : file);
const same = file => (win ? file.replace(/^\/([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase() + ':') : file);
const hostFile = file => (win ? file.slice(1).replaceAll('/', '\\') : file);
// The folder shown: Open Folder's choice, or the workspace. Saves are relative to config.workspace (the workspace, or the
// folder outside it that main set as the daemon's Dev root).
const root = URI.from({ scheme: 'vscode-remote', authority, path: uriPath(config.folder ?? config.workspace) });
const guardRoot = URI.from({ scheme: 'vscode-remote', authority, path: uriPath(config.workspace) });
await createIndexedDBProviders();
const heavy = Object.fromEntries(['node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', '.astro', '.git/objects', '.git/subtree-cache']
  .map(folder => ['**/' + folder + '/**', true]));
await initUserConfiguration(JSON.stringify({ 'workbench.colorTheme': 'P9 Prime', 'workbench.startupEditor': 'none', 'workbench.editor.enablePreview': false,
  'files.hotExit': 'onExitAndWindowClose', 'workbench.localHistory.enabled': false, 'security.workspace.trust.enabled': false,
  'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'remote.extensionKind': { 'openai.codex-audio': ['workspace'] },
  // Builder's long-running VS Code-over-SSH OOM: the watcher took one inotify watch per folder (29,346 on the real ICM tree,
  // 82% of them in these folders) and search walked them too. Generated and dependency folders only; the tree stays visible.
  'files.watcherExclude': heavy, 'search.exclude': heavy, 'search.followSymlinks': false }));
const theme = registerExtension({ name: 'prime', publisher: 'p9', version: '0.0.1', engines: { vscode: '*' },
  contributes: { themes: [{ id: 'P9 Prime', label: 'P9 Prime', uiTheme: 'vs-dark', path: './prime-theme.json' }],
    // A default, not a user setting: initUserConfiguration skips a settings file that already exists, and Alt Z still toggles it.
    configurationDefaults: { 'editor.wordWrap': 'on' } } }, ExtensionHostKind.LocalProcess);
theme.registerFileUrl('./prime-theme.json', new URL('./prime-theme.json', location.href).href);

// The guard boundary, installed on the remote file provider's class before the workbench starts, so no instance of it
// ever runs unguarded. Inside the workspace: reads remember the sha256 of the bytes they got, and writes send the hash the
// editor's own text was loaded from to the guarded save, which refuses if the disk changed since. The editor host's own
// data folder (settings, extension state): unchanged, once main confirms the real path is a plain file inside it. Any other
// path fails closed, so another name for a workspace file (a symlink, a bind mount) cannot skip the guard.
const prefix = same(uriPath(config.workspace)) + '/', hostData = same(uriPath(config.data)) + '/';
const relative = uri => (same(uri.path).startsWith(prefix) ? same(uri.path).slice(prefix.length) : null);
const passThrough = uri => {
  if (uri.path.split('/').some(part => part === '.' || part === '..')) throw new Error('P9 refused a path with . or .. in it.');
  // Windows: a backslash is another separator, and a colon after the drive names an NTFS alternate stream (a.txt:x).
  if (win && /[\\:]/.test(uri.path.slice(3))) throw new Error('P9 refused a path with \\ or : in it.');
  if (relative(uri) !== null) return false;
  if (same(uri.path).startsWith(hostData)) return true;
  throw new Error('P9 writes only inside the workspace (' + config.workspace + '); ' + uri.path + ' is outside it.');
};
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
// pending: the last few reads of each file (hash and text). loaded: the hash a save is based on, set only when the editor's
// own clean model resolves (below) or a save lands, so a diff, compare or extension read never moves it.
const pending = new Map(), loaded = new Map();
const lines = text => text.replace(/\r\n?/g, '\n');
const guarded = RemoteFileSystemProviderClient.prototype, base = Object.getPrototypeOf(guarded);
const baseCapabilities = Object.getOwnPropertyDescriptor(base, 'capabilities').get;
// No open/read/write handles (4), folder copy (8), read streams (16) or clones (131072): every workspace read and write uses readFile/writeFile below.
Object.defineProperty(guarded, 'capabilities', { get() { return baseCapabilities.call(this) & ~4 & ~8 & ~16 & ~131072; }, configurable: true });
for (const op of ['open', 'write', 'readFileStream', 'copy', 'cloneFile']) guarded[op] = () => { throw new Error('P9 turned off ' + op + ' for editor files.'); };
guarded.readFile = async function (uri, ...rest) {
  const bytes = await base.readFile.call(this, uri, ...rest), name = relative(uri);
  if (name !== null) {
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {} // not UTF-8: P9 cannot save it anyway
    pending.set(name, [...(pending.get(name) ?? []).slice(-3), { hash: await sha256(bytes), text }]);
  }
  return bytes;
};
guarded.writeFile = async function (uri, bytes, options) {
  if (passThrough(uri)) {
    if (!(await window.p9dev.hostPath(hostFile(uri.path), 'write'))) throw new Error('P9 refused ' + uri.path + ': not a plain file inside the editor host folder.');
    return base.writeFile.call(this, uri, bytes, options);
  }
  const name = relative(uri);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('P9 saves UTF-8 text only.'); } // a BOM stays
  // New File and Save As (create flag) go through the create-only route. A name already on disk (Save As after VS Code's
  // Replace prompt; Builder, 2026-10-18: "replace save as or rename it. just like normal file explorers") is replaced by a
  // guarded save on the bytes read here, so a change on disk in between still conflicts.
  let basis = loaded.get(name);
  if (basis === undefined) {
    if (!options?.create) throw new Error('P9 saves only files it has opened.');
    const made = await window.p9dev.create(name, text);
    if (made.kind === 'created') { loaded.set(name, made.hash); return; }
    if (made.error !== 'file-exists') throw new Error('P9 could not create the file: ' + made.error);
    basis = await sha256(await base.readFile.call(this, uri));
  }
  const result = await window.p9dev.save(name, basis, text);
  if (result.kind === 'saved') { loaded.set(name, result.hash); return; }
  if (result.kind === 'conflict') throw new Error(`P9 refused the save: the file changed on disk (${result.reason}). Your edit is kept here and in the recovery folder (${result.conflict}).`);
  throw new Error('P9 could not save: ' + (result.error ?? result.code ?? result.reason ?? 'daemon unavailable'));
};
// ponytail: explorer rename/delete/new folder inside the workspace fail closed (new files go through writeFile above); packages/files has no guarded rename yet. Use the terminal.
for (const op of ['rename', 'delete', 'mkdir']) guarded[op] = async function (uri, ...rest) {
  const paths = op === 'rename' ? [uri, rest[0]] : [uri];
  if (!paths.every(passThrough)) throw new Error(`P9 does not ${op} workspace files from the editor yet; use the terminal.`);
  // These act on the last name itself (a link is renamed or deleted, never followed), so only its real folder is checked.
  for (const { path } of paths) if (!(await window.p9dev.hostPath(hostFile(path), 'name'))) throw new Error('P9 refused ' + path + ': its real folder is outside the editor host folder.');
  return base[op].call(this, uri, ...rest);
};

// Open Folder: main's picker (and its confirm for a folder outside the workspace); main loads this page again on the folder it took.
const openFolder = async () => {
  const result = await window.p9dev.openFolder();
  if (result.error) v.window.showErrorMessage(result.error === 'root-refused'
    ? 'P9 does not open that folder: it holds the workspace, your home folder or P9\'s own files.' : 'P9 could not open that folder: ' + result.error);
  return Boolean(result.ok);
};
await initialize({ ...getAuthentication(), ...getTesting(), ...getTask(), ...getGallery({ webOnly: false }), ...getConfiguration(), ...getModel(),
  ...getExtensions(), ...getRemote({ scanRemoteExtensions: true }), ...getSearch(), ...getTerminal(), ...getScm(), ...getDebug(), ...getStorage(),
  ...getWorkingCopy(), ...getKeybindings(), ...getTextmate(), ...getLanguages(), ...getTheme(), ...getNotifications(), ...getOutput(), ...getTrust(),
  // Extension pages (webviews) load from p9://webview, an origin walled off from this page and window.p9dev (threat model row 5).
  ...getExplorer(), ...getWorkbench(undefined, 'p9://webview') }, document.querySelector('#workbench'), {
  remoteAuthority: authority, connectionToken: config.token,
  // The Extensions view browses Open VSX, the same gallery the editor host installs from (Builder, 2026-10-17: "itll be fine to install the extensions").
  productConfiguration: { commit: config.commit, quality: 'stable', nameShort: 'P9', nameLong: 'P9 Event Horizon',
    extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery', itemUrl: 'https://open-vsx.org/vscode/item',
      resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}' } },
  // Open Folder (threat model row 41): main's native picker; main loads the page again on the folder it took.
  workspaceProvider: { workspace: { folderUri: root }, trusted: true, open: async () => openFolder() }, enableWorkspaceTrust: false,
});
// The workbench stays inert (no keys, no clicks, so no Ctrl+S) until the save basis below is tracked.
const extension = registerExtension({ name: 'dev-focus', publisher: 'p9', version: '0.0.1', engines: { vscode: '*' },
  contributes: { commands: [{ command: 'p9.openInVSCode', title: 'Open in VS Code' }] } }, ExtensionHostKind.LocalProcess);
const v = await extension.getApi();
const service = await getService(IFileService);
await service.activateProvider(root.scheme);
if (!(service.getProvider(root.scheme) instanceof RemoteFileSystemProviderClient)) throw new Error('remote-file-provider-unguarded');
// A read becomes the save basis only when the editor's own clean model resolves from disk (open, revert, reload after a
// disk change), and only the read whose bytes are the ones the model shows (its text, line ending and BOM), so another read
// landing in between never wins. A file with mixed line endings never matches exactly; then a read with the same text counts
// only if every such read had the same bytes. No match (not UTF-8, a guessed legacy encoding, more than 4 reads in between):
// no basis, so the save is refused. A dirty model (a restored hot-exit draft) keeps its basis; with none it cannot save.
const textFiles = await getService(ITextFileService);
const promote = model => {
  const name = relative(model.resource), editor = model.textEditorModel;
  if (name === null || model.isDirty() || !editor) return;
  const reads = (pending.get(name) ?? []).filter(entry => entry.text !== null);
  const exact = (model.getEncoding() === 'utf8bom' ? '﻿' : '') + editor.getValue(1).replace(/\n/g, editor.getEOL());
  const same = lines(editor.getValue()), loose = reads.filter(entry => lines(entry.text.replace(/^﻿/, '')) === same);
  const read = reads.findLast(entry => entry.text === exact) ?? (new Set(loose.map(entry => entry.hash)).size === 1 ? loose[0] : null);
  if (read) loaded.set(name, read.hash); else loaded.delete(name);
};
textFiles.files.onDidResolve(({ model }) => promote(model));
textFiles.files.models.forEach(promote);

// "Open in VS Code": every click asks why and is logged (the Phase 8 retirement gate counts them).
v.commands.registerCommand('p9.openInVSCode', async () => {
  const editor = v.window.activeTextEditor, name = editor && relative(editor.document.uri);
  if (name === null || !editor) return v.window.showInformationMessage('Open a workspace file first.');
  const reason = await v.window.showInputBox({ prompt: 'Why VS Code for this? (logged for the retirement gate)', ignoreFocusOut: true });
  if (!reason?.trim()) return;
  const result = await window.p9dev.openInCode(name, editor.selection.active.line + 1, reason.trim());
  if (!result.ok) v.window.showErrorMessage('Could not open VS Code: ' + result.error);
});
// File > Open Folder and the Explorer's button: the workbench's own dialog service is a stub here, so both go to main.
const dialogs = await getService(IFileDialogService);
// Its methods are prototype getters with a no-op setter (missing-services.js), so a plain assignment is dropped: define them here.
Object.defineProperties(dialogs, { pickFolderAndOpen: { value: () => openFolder() }, pickFileFolderAndOpen: { value: () => openFolder() } });
const button = v.window.createStatusBarItem(v.StatusBarAlignment.Right, 100);
Object.assign(button, { text: '$(link-external) Open in VS Code', tooltip: 'Open this file at this line in VS Code (logged)', command: 'p9.openInVSCode' });
button.show();
document.querySelector('#workbench').inert = false;

// The editor follows the shell's DUWOP look, live: P9 Prime (dark) or Light Modern under the theme's own colours.
const themeService = await getService(IThemeService);
const followLook = async look => {
  await themeService.setColorTheme(look?.dark === false ? 'Default Light Modern' : 'P9 Prime', 2);
  if (!look) return;
  const c = look.colors, bg = c.background, card = c.card, fg = c.foreground, dim = c['muted-foreground'], accent = c.primary;
  await v.workspace.getConfiguration().update('workbench.colorCustomizations', {
    'editor.background': bg, 'editorGutter.background': bg, 'editor.foreground': fg, foreground: fg, descriptionForeground: dim,
    'editorLineNumber.foreground': dim, 'editorLineNumber.activeForeground': fg, 'editorCursor.foreground': accent,
    'editor.selectionBackground': accent.slice(0, 7) + '40', 'editor.lineHighlightBackground': c.muted.slice(0, 7) + '80',
    'sideBar.background': card, 'sideBarSectionHeader.background': card, 'activityBar.background': card, 'panel.background': card,
    'statusBar.background': card, 'statusBar.foreground': dim, 'titleBar.activeBackground': card, 'editorGroupHeader.tabsBackground': card,
    'tab.inactiveBackground': card, 'tab.activeBackground': bg, 'tab.activeBorderTop': accent, 'editorWidget.background': card,
    'input.background': c.muted, 'dropdown.background': c.muted, 'list.activeSelectionBackground': c.accent, 'list.hoverBackground': c.accent,
    'focusBorder': c.ring, 'button.background': accent, 'button.foreground': c['primary-foreground'], 'activityBar.activeBorder': accent,
    'activityBarBadge.background': accent, 'textLink.foreground': accent,
    'sideBar.border': c.border, 'panel.border': c.border, 'editorGroup.border': c.border, 'statusBar.border': c.border,
  }, v.ConfigurationTarget.Global);
};
await followLook(config.look);
window.p9dev.onLook(look => followLook(look).catch(error => console.error('p9: editor look failed:', error.message)));
await (await getService(IExtensionService)).whenInstalledExtensionsRegistered();
// Hooks for the Electron tests (test/dev.test.mjs); the page's own code already holds this API.
window.devFocus = { v, root, open: async name => v.window.showTextDocument(await v.workspace.openTextDocument(v.Uri.joinPath(v.Uri.parse(guardRoot.toString()), name)), { preview: false }) };
// p9 edit / p9 diff (threat model row 14): main sends only checked workspace-relative names, once this page can open them.
const fileUri = name => v.Uri.joinPath(v.Uri.parse(guardRoot.toString()), name);
window.p9dev.onOpen(async request => {
  try {
    if (request.open === 'diff') await v.commands.executeCommand('vscode.diff', fileUri(request.a), fileUri(request.b), request.a + ' ↔ ' + request.b, { preview: false });
    else {
      const at = new v.Position(request.line - 1, 0);
      await v.window.showTextDocument(await v.workspace.openTextDocument(fileUri(request.name)), { preview: false, selection: new v.Range(at, at) });
    }
  } catch (error) { v.window.showErrorMessage('P9 could not open it: ' + error.message); }
});
window.devFocusReady = true;
