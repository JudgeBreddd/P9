// A chat's Artifacts and changes list (the 'chat-files' side slot; chat-view.mjs keeps the panel's state, CF, and its open and
// follow rules). Loaded by chat-view's renderChatFiles when the panel first opens, so the shell's startup JS stays inside its
// budget (shell-bundle.test.mjs). Moved out of chat-view.mjs as it was, plus MC-13 and MC-14 below.
import { esc, copy } from './helpers.mjs';
import { KIND_NAMES } from './artifact.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
// An agent's file path as a workspace path ('proj/notes.md'), or null outside the workspace (or while its path is not known
// yet). A relative path is from the chat's folder.
function wsPath(CF, p, folder) {
  p = fwd(p); const ws = CF.ws && fwd(CF.ws).replace(/\/$/, '');
  const rel = /^(\/|[A-Za-z]:\/)/.test(p) ? (ws && p.startsWith(ws + '/') ? p.slice(ws.length + 1) : null) : (folder ? folder + '/' : '') + p;
  const parts = rel?.split('/').filter(x => x && x !== '.');
  return !parts?.length || parts.includes('..') ? null : parts.join('/');
}
// Every finished edit call of the loaded chat that wrote the file, oldest first: its entry for that file (path, created, deleted, diff).
const writes = (s, path) => s.events.filter(e => e.t === 'tool' && e.status === 'completed' && e.files?.some(f => f.path === path)).map(e => e.files.find(f => f.path === path));
// MC-14: what the newest write did. A file this chat created and then edited says so with the count of later edits, instead of
// "Created" forever; one edited by more than one call says how many.
// Counted from the newest create or delete, so a file deleted and written again counts only what came after.
export function kindOf(ws) {
  const i = ws.findLastIndex(w => w.created || w.deleted), after = ws.length - 1 - i;
  if (i >= 0 && ws[i].deleted && !after) return 'Deleted';
  if (i >= 0 && ws[i].created) return after ? `Created, edited ×${after}` : 'Created';
  return after > 1 ? `Edited ×${after}` : 'Edited';
}
// MC-13: the lines added and removed, summed over the file's writes in this chat (the + and - rows of each write's line diff).
// ponytail: each write's diff is kept to 2,000 rows (editFiles), so a bigger change counts only those; a Write over an existing
// file with no diff counts every line as added.
export function linesOf(ws) {
  let add = 0, del = 0;
  for (const w of ws) for (const [k] of w.diff ?? []) k === 'add' ? add++ : k === 'del' && del++;
  return { add, del };
}

export function render({ outer, CF, s, all, GH, cfKey, openArtifact, again }) {
  const b = outer.side.body, changes = CF.tab === 'changes';
  const arts = all.filter(it => it.type === 'artifact'), files = all.filter(it => it.type === 'file'), items = changes ? files : arts;
  const row = (it, i) => {
    if (it.type === 'artifact') return `<li><button type="button" class="cf-item" data-cf="${i}" title="Open the artifact"><span class="art-kind">${esc(KIND_NAMES[it.art.kind])}</span><span class="cf-name">${esc(it.art.title)}</span><span class="cf-sub">Artifact${it.versions.length > 1 ? ` · ${it.versions.length} versions` : ''}</span></button></li>`;
    const rel = wsPath(CF, it.path, s.folder), shown = rel ?? fwd(it.path), cut = shown.lastIndexOf('/');
    const where = rel === null ? (CF.ws ? 'outside the workspace, ' : '') + (shown.slice(0, cut) || '/') : cut < 0 ? 'workspace' : shown.slice(0, cut);
    const ws = writes(s, it.path), { add, del } = linesOf(ws);
    const lines = add || del ? `<span class="cf-lines" title="${add} line${add === 1 ? '' : 's'} added, ${del} removed, over ${ws.length} write${ws.length === 1 ? '' : 's'} in this chat"><span class="cf-add">+${add}</span> <span class="cf-del">−${del}</span></span>` : '';
    return `<li><button type="button" data-cf="${i}" title="Show the changes to ${esc(shown)} (read-only)" class="cf-item" data-cf-file><span class="art-kind">Diff</span><span class="cf-name">${esc(shown.slice(cut + 1))}</span>${lines}<span class="cf-sub">${esc(kindOf(ws) + ' · ' + where)}</span></button>`
      + `<button type="button" ${GH} data-cf-copy="${i}" title="Copy ${esc(fwd(it.path))}">Copy path</button></li>`;
  };
  const tab = (id, label, n) => `<button type="button" role="tab" ${GH} data-cf-tab="${id}" aria-selected="${CF.tab === id}">${label} <span class="cf-n">${n}</span></button>`;
  const html = `<div class="cf-tabs" role="tablist">${tab('artifacts', 'Artifacts', arts.length)}${tab('changes', 'Changes', files.length)}</div>`
    + (items.length ? `<ul class="cf-list" role="tabpanel">${items.map(row).join('')}</ul>` : `<p class="empty" role="tabpanel">${changes ? 'No changes yet. The files this chat edits show here; click one to read its diff.' : 'No artifacts yet. The artifacts this chat posts show here.'}</p>`);
  if (CF.html === html) return; // called on every chat change: the DOM is left alone when nothing in it changed
  CF.html = html; b.innerHTML = html;
  b.querySelectorAll('[data-cf-tab]').forEach(el => el.onclick = () => { CF.tab = el.dataset.cfTab; localStorage.setItem(cfKey(CF.sid), CF.tab); again(); });
  b.querySelectorAll('[data-cf]').forEach(el => el.onclick = () => { const it = items[+el.dataset.cf]; if (it.type === 'artifact') openArtifact({ ...it.art, sid: s.id, list: true, versions: it.versions.map(v => ({ ...v, sid: s.id })) }); else openChange(CF, s, it, openArtifact); });
  b.querySelectorAll('[data-cf-copy]').forEach(el => el.onclick = () => copy(fwd(items[+el.dataset.cfCopy].path), el));
}
// A changed file's diffs, read-only, in the artifact view as plain text (artifact.mjs frameDoc 'diff'): every finished edit call
// of the loaded chat that wrote it, oldest first, each as the line diff the chat shows (editFiles keeps one per file).
function openChange(CF, s, it, openArtifact) {
  const edits = writes(s, it.path).map(f => f.diff);
  const src = edits.map((rows, i) => (edits.length > 1 ? `@@ Edit ${i + 1} of ${edits.length} @@\n` : '')
    + (rows?.length ? rows.map(([k, l]) => (k === 'file' || k === 'hunk' ? '' : k === 'add' ? '+ ' : k === 'del' ? '- ' : '  ') + l).join('\n') : 'No diff was recorded for this edit.')).join('\n\n');
  openArtifact({ kind: 'diff', lang: 'diff', mode: 'panel', title: wsPath(CF, it.path, s.folder) ?? fwd(it.path), src, sid: s.id, list: true });
}
