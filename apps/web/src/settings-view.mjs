// Settings and the setup wizard. Split out of controller.mjs's mountShell (F9) with no change in behaviour; names that stay in mountShell come in through outer.
import { esc, info, modes, LOOSE } from './helpers.mjs';
import { missionKeys, missionShown, missionValue, PATH_KEYS } from './mission-files.mjs';
import { SECURITY, warnsLoose, unrestricted, setWarnsLoose, setStarts } from './security.mjs';
import { maintenanceGroup, MAINTENANCE } from './maintenance.mjs';

export function installSettings(outer) {
async function saveSettings(next) {
  try { outer.settings = window.p9?.setSettings ? await window.p9.setSettings(next) : (localStorage.setItem('p9-settings', JSON.stringify(next)), next); }
  catch { outer.toast({ kind: 'settings', txt: 'Settings not saved', level: 'bad' }, true); }
  applySettings();
}
function applySettings() {
  document.querySelectorAll('[data-focus-btn]').forEach(b => { b.hidden = !outer.focusOn(b.dataset.focusBtn); });
  if (!outer.focusOn(outer.S.focus)) outer.setFocus(Object.keys(outer.settings.focus).find(outer.focusOn), true);
  if (outer.$('#setDlg').open) renderSettings();
  outer.loadPetLook();
}
// Pets in Settings: the library (add from a folder picker, remove), then one focus mode's pets at a time.
const PET_WHY = { name: 'its folder name must be lowercase letters, digits and dashes', invalid: 'it is not a petdex pet (pet.json and a sheet)', exists: 'a pet with that name is already in P9', command: 'paste the install command from petdex.dev', unknown: 'petdex.dev has no pet by that name', offline: 'petdex.dev could not be reached' };
function petSettings() {
  const mode = outer.petMode ||= outer.S.focus, f = outer.settings.pet[mode], pick = (role, label, none) => `<label class="set-row"><span><strong>${label}</strong></span><span class="spacer"></span><select data-slot="input" id="setPet-${role}" data-pet-role="${role}"><option value="">${none}</option>${outer.pets.pets.map(p => `<option value="${esc(p.name)}" ${f[role] === p.name ? 'selected' : ''}>${esc(p.displayName)}</option>`).join('')}</select>${info('The pet shown while ' + (role === 'system' ? 'P9 itself' : label) + ' is working.', 'pets')}</label>`;
  return `<fieldset class="set-group"><legend>Pets ${info('A small animated character (a petdex pet) that shows while an agent works, in place of the spinner (in Chat Focus chats and the top bar).', 'pets')}</legend>`
    + `<p class="muted sm">Find a pet at <a id="petdexLink" href="https://petdex.dev" target="_blank" rel="noopener">petdex.dev</a>, copy its install command and paste it below.</p>`
    + (window.p9?.installPets ? `<form class="set-row" id="petInstallForm"><input data-slot="input" id="petInstall" placeholder="npx petdex@latest install boba" autocomplete="off" spellcheck="false" style="flex:1"><button data-slot="button" data-variant="default" id="petInstallGo">Install</button></form>` : '')
    + `<div class="pet-lib">${outer.pets.pets.map(p => `<figure><canvas data-thumb="${esc(p.name)}" width="192" height="208"></canvas><figcaption>${esc(p.displayName)}</figcaption><button data-slot="button" data-variant="ghost" data-size="icon-sm" data-pet-remove="${esc(p.name)}" title="Remove ${esc(p.displayName)}">×</button></figure>`).join('') || '<p class="muted sm">No pets yet.</p>'}</div>`
    + (window.p9?.addPets ? `<div class="set-row">${outer.pets.importable ? `<button data-slot="button" data-variant="default" id="petImport">Import ${outer.pets.importable} new petdex pet${outer.pets.importable === 1 ? '' : 's'}</button>` : ''}<button data-slot="button" data-variant="outline" id="petAdd">Add pets…</button></div>` : '')
    + `<div class="set-row" role="group" aria-label="Focus mode">${Object.entries(outer.focusNames).map(([m, n]) => `<button data-slot="button" data-variant="${m === mode ? 'default' : 'outline'}" data-size="sm" data-pet-mode="${m}" aria-pressed="${m === mode}">${n}</button>`).join('')}</div>`
    + `<label class="set-row"><input type="checkbox" id="setPetOn" ${f.on ? 'checked' : ''}><span><strong>Show pets in ${outer.focusNames[mode]}</strong><span class="muted sm">Off: chats show no pet. The top-bar pet always shows.</span></span><span class="spacer"></span>${info('Shows the pets in this focus mode\'s chats.', 'pets')}</label>`
    + `<label class="set-row"><span><strong>Size</strong></span><span class="spacer"></span><input type="range" id="setPetSize" min="24" max="128" step="4" value="${f.size}"><span class="mono">${f.size}px</span>${info('How big the pets are in this focus mode.', 'pets')}</label>`
    + pick('system', 'System', 'None (spinner)') + pick('claude', 'Claude', 'Same as System') + pick('codex', 'Codex', 'Same as System')
    + `<div class="set-row"><span class="muted sm">Show, size and positions stay per focus.</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" id="petAll" ${Object.values(outer.settings.pet).every(o => outer.PET_ROLES.every(r => o[r] === f[r])) ? 'disabled' : ''}>Use these pets in all focus modes</button></div>`
    + `<div class="set-row"><span class="muted sm">Drag a pet to move it.</span><span class="spacer"></span><button data-slot="button" data-variant="ghost" data-size="sm" id="petReset" ${f.top || f.pane || Object.keys(outer.petSpots).length ? '' : 'disabled'}>Reset positions</button></div></fieldset>`;
}
function wirePetSettings() {
  const mode = outer.petMode, setPet = change => saveSettings({ ...outer.settings, pet: { ...outer.settings.pet, [mode]: { ...outer.settings.pet[mode], ...change } } });
  document.querySelectorAll('[data-pet-role]').forEach(sel => { sel.onchange = e => setPet({ [sel.dataset.petRole]: e.target.value || null }); });
  document.querySelectorAll('[data-pet-mode]').forEach(b => { b.onclick = () => { outer.petMode = b.dataset.petMode; renderSettings(); }; });
  outer.$('#setPetOn').onchange = e => setPet({ on: e.target.checked });
  outer.$('#setPetSize').onchange = e => setPet({ size: +e.target.value });
  outer.$('#setPetSize').oninput = e => { e.target.nextElementSibling.textContent = e.target.value + 'px'; };
  outer.$('#petReset').onclick = () => { for (const k in outer.petSpots) delete outer.petSpots[k]; localStorage.removeItem('p9-pet-spots'); setPet({ top: null, pane: null }); };
  // Builder, 2026-10-19: copy this focus's three pet picks to every focus; show, size and positions stay per focus.
  outer.$('#petAll').onclick = () => saveSettings({ ...outer.settings, pet: Object.fromEntries(Object.entries(outer.settings.pet).map(([m, o]) => [m, { ...o, ...Object.fromEntries(outer.PET_ROLES.map(r => [r, outer.settings.pet[mode][r]])) }])) });
  const refresh = async () => { outer.pets = await window.p9.listPets().catch(() => outer.pets); renderSettings(); };
  const addWith = add => async () => {
    const r = await add().catch(() => null);
    if (!r) return outer.toast({ kind: 'pets', txt: 'Pets not added', level: 'bad' }, true);
    if (r.added.length || r.refused.length) outer.toast({ kind: 'pets', level: r.refused.length ? 'warn' : 'ok', txt: [r.added.length && 'Added ' + r.added.map(p => p.name).join(', ') + '.', ...r.refused.map(p => `${p.name} not added: ${PET_WHY[p.why] || p.why}.`)].filter(Boolean).join(' ') }, true);
    refresh();
  };
  outer.$('#petdexLink').onclick = e => { if (window.p9?.openPetdex) { e.preventDefault(); window.p9.openPetdex(); } }; // a browser preview follows the link
  if (outer.$('#petAdd')) outer.$('#petAdd').onclick = addWith(() => window.p9.addPets());
  if (outer.$('#petImport')) outer.$('#petImport').onclick = addWith(() => window.p9.importPets());
  if (outer.$('#petInstallForm')) outer.$('#petInstallForm').onsubmit = e => { e.preventDefault(); outer.$('#petInstallGo').disabled = true; outer.$('#petInstallGo').textContent = 'Installing…'; addWith(() => window.p9.installPets(outer.$('#petInstall').value))().finally(renderSettings); };
  document.querySelectorAll('[data-pet-remove]').forEach(b => { b.onclick = async () => {
    const name = b.dataset.petRemove, shown = outer.pets.pets.find(p => p.name === name)?.displayName || name;
    if (!confirm(`Remove ${shown} from P9? Any copy in ~/.codex/pets stays.`)) return;
    if (!(await window.p9.removePet(name).catch(() => null))) return outer.toast({ kind: 'pets', txt: shown + ' not removed', level: 'bad' }, true);
    outer.IND.looks.delete(name);
    const clear = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, ['claude', 'codex', 'system'].includes(k) && v === name ? null : v]));
    await saveSettings({ ...outer.settings, pet: Object.fromEntries(Object.entries(outer.settings.pet).map(([m, f]) => [m, clear(f)])) });
    refresh();
  }; });
  document.querySelectorAll('canvas[data-thumb]').forEach(async cv => {
    const name = cv.dataset.thumb;
    if (!outer.IND.looks.has(name)) outer.IND.looks.set(name, await outer.petLook(name));
    const look = outer.IND.looks.get(name); if (look) cv.getContext('2d').drawImage(look.img, 0, 0, 192, 208, 0, 0, 192, 208);
  });
}
function missionGroup() {
  const s = outer.missionFiles.settings;
  return `<fieldset class="set-group" id="setMission"><legend>Mission Control files ${info('The files and folders Mission Control reads, from its settings file (for the Mission Control focus). Each row saves when you leave it.', 'mission-control-files')}</legend>`
    + missionKeys().map(([k, name, kind, tip]) => `<label class="set-row"><span><strong>${esc(name)}</strong></span><span class="spacer"></span>`
      + (k === 'notes_roots' ? `<textarea data-slot="input" class="mono" data-mission="${k}" rows="2" maxlength="8000" spellcheck="false">${esc(missionShown(k, s[k]))}</textarea>`
        : `<input data-slot="input" class="mono" data-mission="${k}" value="${esc(missionShown(k, s[k]))}" title="${esc(missionShown(k, s[k]))}" maxlength="400" autocomplete="off" spellcheck="false">`)
      + (window.p9.pickFolder && kind ? `<button data-slot="button" data-variant="outline" data-size="sm" data-mission-pick="${k}:${kind}">Pick</button>` : '')
      + info(tip, 'mission-control-files') + '</label>').join('')
    + '<p class="muted sm">The old file is kept as settings.json.bak.</p></fieldset>';
}
async function saveMission(change) {
  const r = await window.p9.chat('saveMissionFiles', change).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } }));
  const box = outer.$('#setBody').querySelector(`[data-mission="${Object.keys(change)[0]}"]`), row = box?.closest('.set-row');
  row?.querySelector('[data-mission-err]')?.remove(); box?.removeAttribute('aria-invalid');
  if (r.status === 200) { outer.missionFiles = { ...outer.missionFiles, settings: r.body.settings }; outer.loadMission(); return; }
  const why = 'Not saved: ' + (r.body?.detail || WIZ_ERR[r.body?.error]?.[0] || r.body?.error || r.status);
  if (!row) return outer.toast({ kind: 'mission-files', txt: why, level: 'bad' }, true);
  box.setAttribute('aria-invalid', 'true');
  row.insertAdjacentHTML('beforeend', `<small class="field-err" data-mission-err role="alert">${esc(why)}</small>`);
}
// A narrow box shows the end of a long path (the file name), not the start every path shares; the full path is the hover.
const showEnd = box => { box.title = box.value; box.scrollLeft = box.scrollWidth; };
function wireMission() {
  outer.$('#setBody').querySelectorAll('input[data-mission]').forEach(box => { showEnd(box); box.onblur = () => showEnd(box); });
  outer.$('#setBody').querySelectorAll('[data-mission]').forEach(box => { box.onchange = () => saveMission({ [box.dataset.mission]: missionValue(box.dataset.mission, box.value) }); });
  outer.$('#setBody').querySelectorAll('[data-mission-pick]').forEach(b => { b.onclick = async e => {
    e.preventDefault();
    const [k, kind] = b.dataset.missionPick.split(':');
    const picked = await window.p9.pickFolder(kind).catch(() => undefined);
    if (picked === undefined) return;
    if (picked === null || picked === '') return outer.toast({ kind: 'mission-files', txt: WIZ_ERR[picked === '' ? 'pick-root' : 'pick-outside'].join(' '), level: 'warn' }, true); // BL6
    outer.$('#setBody').querySelector(`[data-mission="${k}"]`).value = picked;
    saveMission({ [k]: picked });
  }; });
}
// Settings > Remote (desktop/remote.mjs, D3): the remotes added here, then the Host aliases of ~/.ssh/config (no wildcards or
// negations; remote.mjs). Nothing is built in; Add remote takes a Host name or user@address.
function serverRow() {
  const { host, connected, error, hosts, remotes = [], keep = {}, noKey = [] } = outer.serverInfo, all = [...new Set([...remotes, ...hosts])];
  // Row I1: what P9 on each remote does when you disconnect, as answered with Do not ask again; Ask until then.
  const keepPick = h => window.p9?.remoteKeepSetting ? '<select data-slot="select" data-remote-keep="' + esc(h) + '" aria-label="P9 on ' + esc(h) + ' when you disconnect" title="What P9 on ' + esc(h) + ' does when you disconnect">'
    + [['', 'Ask'], ['keep', 'Always on'], ['stop', 'Temporary']].map(([v, t]) => '<option value="' + v + '"' + ((keep[h] === true ? 'keep' : keep[h] === false ? 'stop' : '') === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' : '';
  const note = host ? (connected ? 'This window works on ' + host + '. Chats there keep running when you switch or quit.' : 'Connecting to ' + host + (error ? ' (' + error + ')' : '') + '.')
    : all.length ? 'This window works on this computer. Connect to a remote to work on its P9 over ssh.' : 'No remotes yet. Add one below.';
  const rows = all.map(h => '<li class="set-row"><span><strong>' + esc(h) + '</strong><span class="muted sm">' + (remotes.includes(h) ? 'Added here' : 'From ~/.ssh/config') + '</span></span><span class="spacer"></span>' + keepPick(h)
    + (noKey.includes(h) && window.p9?.sshKeySetting ? '<button data-slot="button" data-variant="ghost" data-size="sm" data-key-again="' + esc(h) + '" title="After the next password login to ' + esc(h) + ', P9 asks again whether to add its own key">Offer a P9 key again</button>' : '')
    + (h === host ? '<span class="muted sm">' + (connected ? 'Connected' : 'Connecting…') + '</span>' : '<button data-slot="button" data-variant="outline" data-size="sm" data-remote-go="' + esc(h) + '">Connect</button>')
    + (remotes.includes(h) && h !== host ? '<button data-slot="button" data-variant="ghost" data-size="sm" data-remote-remove="' + esc(h) + '" aria-label="Remove ' + esc(h) + '">Remove</button>' : '') + '</li>').join('');
  return '<fieldset class="set-group" id="setRemote"><legend>Remote ' + info('Remote mode: chat, Mission Control, the terminal and Dev Focus use the P9 on another machine, through one ssh tunnel that forwards its socket. This computer\'s P9 keeps running, and Use this computer goes back. If ssh needs a password, P9 asks for it in its own window and can add its own key so it stops asking. Folder pickers, Open in VS Code and Repair stay on this computer.', 'remote-connect-send-to-remote-and-send-files') + '</legend>'
    + '<p class="muted sm">' + esc(note) + '</p>' + (rows ? '<ul class="remote-list">' + rows + '</ul>' : '')
    + openOnRow(all)
    + '<form class="set-row" id="setRemoteAdd"><input data-slot="input" id="setRemoteName" placeholder="Host name or user@address" aria-label="Remote to add" maxlength="253" autocomplete="off" spellcheck="false"><button data-slot="button" data-variant="default">Add remote</button></form>'
    + '<p class="warn sm" id="setRemoteErr" role="alert" hidden></p>'
    + (host ? '<div class="set-row"><span class="spacer"></span><button data-slot="button" data-variant="outline" id="setServerLocal">Use this computer</button></div>' : '') + '</fieldset>';
}
// c18 (threat model row 66): Settings > Security settings, the words and the device's part in security.mjs, shared with the phone.
const START = 'p9-mode-default:'; // Unrestricted mode sets the D2 default (row 25a), so new chats here start loosened
function securityGroup(box) {
  const [lock, protect, warn, free] = [SECURITY.lock, SECURITY.protect, SECURITY.warn, SECURITY.unrestricted], both = window.p9?.chat && window.p9?.fileProtection;
  return `<fieldset class="set-group" id="setSecurity"><legend>Security settings ${info('One switch per restriction, and Unrestricted mode for all of them at once. The defaults keep P9 careful; turn off what gets in your way. The phone has the same four.', 'security-settings')}</legend>`
    + (window.p9?.chat ? box('setLock', lock[0], outer.agentLock === true, outer.agentLock === null ? SECURITY.unknown : lock[1], outer.agentLock === null, lock[2], 'agent-lock') : '')
    + (window.p9?.fileProtection ? box('setProtect', protect[0], outer.fileProtect !== false, outer.fileProtect === null ? SECURITY.unknown : outer.fileProtect ? protect[1] : SECURITY.protectOff, outer.fileProtect === null, protect[2], 'file-protection') : '')
    + box('setWarn', warn[0], warnsLoose(), warn[1], false, warn[2], 'security-settings')
    + (window.p9?.openLink ? box('setLinks', SECURITY.links[0], !localStorage.getItem('p9-link-ok'), SECURITY.links[1], false, SECURITY.links[2], 'security-settings') : '')
    + (both ? box('setFree', free[0], unrestricted(outer.agentLock, outer.fileProtect, START), free[1], outer.agentLock === null || outer.fileProtect === null, free[2], 'security-settings') : '')
    + '</fieldset>';
}
// On: File protection first, through main's native warning; "Keep protection on" there changes nothing else. With
// protection already off that warning never shows, so Unrestricted asks once itself (row 25a: no silent loosened default).
async function setUnrestricted(on) {
  if (on && outer.fileProtect === false && !confirm('Turn on Unrestricted mode?\n\n' + SECURITY.unrestricted[1])) return renderSettings();
  const r = outer.fileProtect === !on ? null : await window.p9.fileProtection(!on).catch(() => null);
  outer.fileProtect = r?.status === 200 ? r.body.on : outer.fileProtect;
  if (outer.fileProtect !== !on) return renderSettings();
  if (on && outer.agentLock) { const l = await outer.liveChat.call('setLock', { on: false }); outer.agentLock = l.status === 200 ? l.body.on : outer.agentLock; }
  setWarnsLoose(!on); setStarts(on, START);
  if (!on) localStorage.removeItem('p9-link-ok'); // review 3 L5: off asks before agent links again
  renderSettings();
}
// Attempt 2 items 6 and 7 (the owner): five pages, picked on the left; every row moves, unchanged, to the page it mainly
// affects. The wiring below finds rows by id in #setBody, so it does not care which page holds them.
const SET_PAGES = ['General', 'Chat Focus', 'Dev Focus', 'Mission Control', 'Remote Connect'];
const SET_PAGE_OF = { 'New chats start in': 'Chat Focus', 'Provider profiles': 'Chat Focus', 'Mission Control files': 'Mission Control', Remote: 'Remote Connect', 'Send files': 'Remote Connect' };
// Settings opened at one row (Add a machine, a send limit): show the page that holds it, then the row.
const settingsAt = el => { if (!el) return; outer.$('[data-set-page="' + el.closest('.set-page').dataset.page + '"]').click(); el.scrollIntoView({ block: 'center' }); };
function settingsPages() {
  const body = outer.$('#setBody'), legend = g => g.querySelector('legend')?.firstChild?.textContent.trim() || '';
  const pages = Object.fromEntries(SET_PAGES.map(n => { const p = document.createElement('section'); p.className = 'set-page'; p.dataset.page = n; p.setAttribute('aria-label', n); return [n, p]; }));
  const group = (page, title, tip, rows) => { const g = document.createElement('fieldset'); g.className = 'set-group'; g.innerHTML = '<legend>' + title + ' ' + tip + '</legend>'; g.append(...rows); pages[page].append(g); };
  const loose = [...body.children].filter(c => c.tagName !== 'FIELDSET'), chatRows = loose.filter(c => c.querySelector('#setCloseSend'));
  group('General', 'General', info('The docs, zoom, your name, and how P9 opens.', 'settings'), loose.filter(c => !chatRows.includes(c)));
  if (chatRows.length) group('Chat Focus', 'Chat windows', info('How a chat window opened from a card or the Notification Center behaves.', 'settings'), chatRows);
  for (const g of [...body.children]) {
    // Focus modes: each mode's on/off row goes to that mode's page, under the same heading and tip.
    if (legend(g) === 'Focus modes') { for (const row of [...g.querySelectorAll('.set-row')]) { const one = g.cloneNode(false); one.append(g.querySelector('legend').cloneNode(true), row); pages[outer.focusNames[row.querySelector('input').id.slice(5)]].append(one); } continue; }
    pages[SET_PAGE_OF[legend(g)] ?? 'General'].append(g);
  }
  for (const p of Object.values(pages)) if (!p.children.length) p.innerHTML = '<p class="muted sm">Nothing to set here in this window.</p>';
  body.replaceChildren(...Object.values(pages));
  outer.$('#setDlg .set-pages')?.remove();
  const nav = document.createElement('nav'); nav.className = 'set-pages'; nav.setAttribute('aria-label', 'Settings pages');
  const show = () => { for (const p of Object.values(pages)) p.hidden = p.dataset.page !== outer.setPage; nav.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.setPage === outer.setPage)); };
  for (const n of SET_PAGES) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = n; b.dataset.setPage = n;
    b.onclick = () => { outer.setPage = n; show(); body.scrollTop = 0; }; nav.append(b);
  }
  show(); outer.$('#setDlg .dlg-head').after(nav);
}
// 0.1.8: where P9 opens next time: where it was last (main's p9-server.json host, as before), this computer, or one remote.
// A remote that does not answer shows the connecting screen, as Connect does. Only with a main that keeps the choice.
function openOnRow(all) {
  if (!window.p9?.remotes || !('openOn' in outer.serverInfo)) return '';
  const openOn = outer.serverInfo.openOn ?? null, places = [...new Set([...all, ...(openOn ? [openOn] : [])])];
  return '<label class="set-row"><span><strong>Open P9 on</strong><span class="muted sm">Applies the next time P9 starts.</span></span><span class="spacer"></span><select data-slot="select" id="setOpenOn" aria-label="Open P9 on"><option value="last">Where it was last</option><option value="local"' + (openOn === '' ? ' selected' : '') + '>This computer</option>'
    + places.map(h => '<option value="' + esc(h) + '"' + (h === openOn ? ' selected' : '') + '>' + esc(h) + '</option>').join('') + '</select></label>';
}
// 0.1.8: beside each agent's starting mode, Default model and Default effort: Agent's default (no override), or the agent's
// own list as this P9 last reported it (O47: the daemon's lists); read fresh at each daemon start, so listed before any chat); with no list (the agent is signed out or never answered), only Agent's default and a word to start a chat.
function defaultsRow(a) {
  const ml = outer.lastModels[a]?.options || [], el = outer.lastPickers[a]?.find(p => outer.pickerKind(p) === 'effort')?.options || [];
  const own = (list, v) => { const n = list.find(o => o.value === v)?.name; return n && !/default/i.test(n) ? ` (${esc(n)})` : ''; }; // MC-16: which one the agent's default is, unless its own name already says so
  const sel = (attr, label, list, now, def) => `<label class="set-pick">${label}<select data-slot="input" ${attr}="${a}" aria-label="${label} for ${outer.names[a]}"><option value="">Agent's default${own(list, def)}</option>${list.map(o => `<option value="${esc(o.value)}"${o.value === now ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`;
  return `<div class="set-row set-defaults"><span><strong>${outer.names[a]}</strong>${ml.length || el.length ? '' : `<span class="muted sm">Start one ${outer.names[a]} chat first: its models and efforts are listed here after that.</span>`}</span><span class="spacer"></span>`
    + `<label class="set-pick">Mode<select data-slot="input" data-default-mode="${a}" aria-label="Default mode for ${outer.names[a]}"><option value="">Last mode picked</option>${modes[a].map(m => `<option${m === outer.defaultMode(a) ? ' selected' : ''}>${m}</option>`).join('')}</select></label>`
    + sel('data-default-model', 'Default model', ml, outer.defaultModel(a), outer.listDef[a]?.model) + sel('data-default-effort', 'Default effort', el, outer.defaultEffort(a), outer.listDef[a]?.pickers?.[outer.lastPickers[a]?.find(p => outer.pickerKind(p) === 'effort')?.id]) + '</div>';
}
// O48 provider profiles (threat model "Provider profiles"): another service that speaks Claude's API, for Claude chats. The
// daemon keeps the key and never sends it back; the page holds it only in the form's field until Save, then redraws.
// profileForm: null, 'new', or the id being edited. CHECKED: services a profile was really run against, with the base URL used.
let profileForm = null, profileNote = '';
const PROVIDERS = [['ollama.com', 'https://ollama.com', true], ['openrouter.ai', 'https://openrouter.ai', false]];
// A7 Delegate: Settings > Delegation. The daemon keeps it (delegate.mjs reads it at each open_chat); null until it answers.
let delegation = null, delegationNote = '';
function delegationGroup() {
  if (!window.p9?.chat || !outer.liveChat?.on) return '';
  const d = delegation, off = d ? '' : ' disabled';
  const sel = (attr, label, aria, opts, now) => `<label class="set-pick">${label}<select data-slot="input" ${attr}${off} aria-label="${aria}">${(now && !opts.some(([v]) => v === now) ? [...opts, [now, now]] : opts).map(([v, n]) => `<option value="${esc(v)}"${v === (now ?? '') ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
  const agents = [['', 'The parent chat\'s'], ...Object.keys(modes).map(a => [a, outer.names[a]]), ...outer.profiles.map(p => ['profile:' + p.id, p.name])];
  // One row per worker, in the order a chat's workers start. A row on a provider profile offers that profile's models.
  const row = (w, i) => { const prof = w.agent.startsWith('profile:') ? outer.profiles.find(p => 'profile:' + p.id === w.agent) : null, a = prof ? 'claude' : w.agent;
    const ml = prof ? prof.models.map(m => [m, m]) : [['', 'Not set'], ...(outer.lastModels[a]?.options || []).map(o => [o.value, o.name])];
    const el = [['', 'Not set'], ...(outer.lastPickers[a]?.find(p => outer.pickerKind(p) === 'effort')?.options || []).map(o => [o.value, o.name])];
    return `<div class="set-row set-dg" data-dg-worker="${i}"><span><strong>Worker ${i + 1}</strong>${a && ml.length < 2 && el.length < 2 ? `<span class="muted sm">Start one ${outer.names[a]} chat first: its models and efforts are listed here after that.</span>` : ''}</span>`
      + sel(`data-dg-agent="${i}"`, 'Agent', `Worker ${i + 1} agent`, agents, w.agent)
      + (w.agent ? sel(`data-dg-model="${i}"`, 'Model', `Worker ${i + 1} model`, ml, w.model || (prof ? prof.models[0] : '')) + sel(`data-dg-effort="${i}"`, 'Effort', `Worker ${i + 1} effort`, el, w.effort) : '') + '</div>'; };
  return `<fieldset class="set-group" id="setDelegation"><legend>Delegation ${info('Delegate: a chat\'s agent can start workers, each one a chat of its own. Here: who may start a sprint, how many workers a chat may run, and what each worker runs on.', 'settings')}</legend>`
    + '<p class="muted sm" data-dg-what>Delegate lets a chat\'s agent hand parts of a job to workers. Each worker is a chat of its own, listed in the sidebar under the chat that started it: you can open it, read it and type in it. Its approvals and questions also show in the chat that started it. A job split up this way is a sprint.</p>'
    + `<div class="set-row"><span><strong>Who starts a sprint</strong><span class="muted sm">Off: agents cannot start workers. Ask me first: P9 asks you in the chat before a chat's first worker, in every mode. Agent decides: no question beyond the mode's own.</span></span>`
    + sel('data-dg-start', '', 'Who starts a sprint', [['off', 'Off'], ['ask', 'Ask me first'], ['agent', 'Agent decides']], d?.start ?? 'ask') + '</div>'
    + `<div class="set-row"><span><strong>Workers per chat</strong><span class="muted sm">The most workers one chat may have running at once. Each has a row below: the first worker a chat starts runs on Worker 1, the next on Worker 2. A row is free again when its worker is stopped. An agent that names its own agent, model or effort for a worker gets that one.</span></span>`
    + sel('data-dg-max', '', 'Workers per chat', Array.from({ length: 20 }, (_, i) => [String(i + 1), String(i + 1)]), String(d?.max ?? 5)) + '</div>'
    + (d ? d.workers.map(row).join('') : '<p class="muted sm" data-dg-wait>Reading from P9…</p>') + (delegationNote ? `<p class="muted sm" data-dg-note>${esc(delegationNote)}</p>` : '') + '</fieldset>';
}
// Drawn again on its own (never the whole page, which would drop what is being typed in another box).
function drawDelegation() { const el = outer.$('#setDelegation'); if (el) { el.outerHTML = delegationGroup(); bindDelegation(); } }
function bindDelegation() {
  const el = outer.$('#setDelegation'); if (!el) return;
  if (!delegation && !el.dataset.asked) { el.dataset.asked = '1'; window.p9.chat('delegation', {}).then(r => { if (r?.status === 200) { delegation = r.body; drawDelegation(); } }).catch(() => {}); }
  const v = q => el.querySelector(q)?.value ?? '';
  el.querySelectorAll('select').forEach(x => { x.onchange = async () => {
    // A row whose agent just changed starts with no model or effort: the old ones belonged to the other agent.
    const max = Number(v('[data-dg-max]')), changed = x.dataset.dgAgent;
    const want = { start: v('[data-dg-start]'), max, workers: Array.from({ length: max }, (_, i) => { const agent = v(`[data-dg-agent="${i}"]`), keep = agent && String(i) !== changed;
      return { agent, model: keep ? v(`[data-dg-model="${i}"]`) : '', effort: keep ? v(`[data-dg-effort="${i}"]`) : '' }; }) };
    const r = await window.p9.chat('delegation', want).catch(() => null);
    if (r?.status === 200) { delegation = r.body; delegationNote = ''; } else delegationNote = 'Not saved: P9 did not take it. Try again in a moment.';
    drawDelegation();
  }; });
}
function profilesGroup() {
  if (!outer.liveChat?.on || !window.p9?.chat) return '';
  const secret = { key: 'Key saved', command: 'Key from a command', none: 'No key yet' };
  const rows = outer.profiles.map(p => `<div class="set-row" data-profile="${esc(p.id)}"><span><strong>${esc(p.name)}</strong><span class="muted sm">${esc(p.baseUrl)}${p.baseUrl.startsWith('http:') ? ' (not encrypted)' : ''} · ${esc(p.models.join(', '))} · ${secret[p.secret] ?? ''}</span></span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" data-profile-edit="${esc(p.id)}">Edit</button><button data-slot="button" data-variant="outline" data-size="sm" data-profile-remove="${esc(p.id)}">Remove</button></div>`).join('');
  const p = profileForm && profileForm !== 'new' ? outer.profiles.find(x => x.id === profileForm) : null;
  const field = (id, label, hint, input) => `<label class="set-row profile-field"><span><strong>${label}</strong><span class="muted sm">${hint}</span></span><span class="spacer"></span>${input}</label>`;
  const form = !profileForm ? `<div class="set-row"><span class="muted sm">${rows ? '' : 'None yet. '}Choose a profile in the chat's Agent picker.</span><span class="spacer"></span><button data-slot="button" data-size="sm" id="profileAdd">Add a profile</button></div>`
    : `<div class="profile-form" id="profileForm">`
    + field('profileName', 'Name', 'What the New chat menu calls it.', `<input data-slot="input" id="profileName" maxlength="40" value="${esc(p?.name ?? '')}" style="width:22em">`)
    + field('profileUrl', 'Base URL', 'The service\'s address for Claude\'s API. This service sees everything the chat sends. ' + PROVIDERS.map(([n, u, ok]) => `<a href="${u}" data-profile-link>${n}</a>${ok ? '' : ' (not checked with P9)'}`).join(', ') + '<span id="profileHttp" style="color:var(--destructive)" hidden> Not encrypted: anyone on the network path can read the chat and the key.</span>', `<input data-slot="input" id="profileUrl" maxlength="300" placeholder="https://" value="${esc(p?.baseUrl ?? '')}" style="width:22em">`)
    + field('profileModels', 'Models', 'One per line, named as the service names them.', `<textarea data-slot="input" id="profileModels" rows="3" style="width:22em">${esc((p?.models ?? []).join('\n'))}</textarea>`)
    + field('profileKey', 'Key', p ? 'Empty keeps what is saved, unless the base URL changes: then type it again. P9 keeps it in one owner-only file and never shows it again.' : 'P9 keeps it in one owner-only file and never shows it again.', `<input data-slot="input" id="profileKey" type="password" autocomplete="off" maxlength="500" style="width:22em">`)
    + field('profileCommand', 'Or a command that prints the key', 'Run at each chat start, without a shell: a program and its arguments, split on spaces.' + (p?.secret === 'command' ? ' One is saved; empty keeps it.' : ''), `<input data-slot="input" id="profileCommand" maxlength="500" autocomplete="off" style="width:22em">`)
    + `<div class="set-row"><span class="sm" style="color:var(--destructive)" id="profileNote" role="alert">${esc(profileNote)}</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" id="profileCancel">Cancel</button><button data-slot="button" data-size="sm" id="profileSave">Save</button></div></div>`;
  return `<fieldset class="set-group" id="setProfiles"><legend>Provider profiles ${info('Another service that speaks Claude\'s API, for Claude chats: its models appear in the New chat menu beside Claude\'s own. A chat on a profile sends everything to that service, runs on the one model it was started on, and stays on this computer.', 'settings')}</legend>${rows}${form}</fieldset>`;
}
function bindProfiles() {
  const g = outer.$('#setProfiles'); if (!g) return;
  const redraw = async () => { await outer.loadProfiles(); renderSettings(); };
  if (outer.$('#profileAdd')) outer.$('#profileAdd').onclick = () => { profileForm = 'new'; profileNote = ''; renderSettings(); outer.$('#profileName')?.focus(); };
  g.querySelectorAll('[data-profile-edit]').forEach(b => { b.onclick = () => { profileForm = b.dataset.profileEdit; profileNote = ''; renderSettings(); }; });
  g.querySelectorAll('[data-profile-remove]').forEach(b => { b.onclick = async () => {
    const id = b.dataset.profileRemove, r = await window.p9.chat('profileRemove', { id }).catch(() => null);
    if (r?.status === 200) for (const s of outer.S.sessions) if (s.profile?.id === id) s.profile = { ...s.profile, gone: true }; // its chats can be read, not continued
    if (profileForm === id) profileForm = null;
    await redraw(); outer.renderChats();
  }; });
  g.querySelectorAll('[data-profile-link]').forEach(a => { a.onclick = e => { e.preventDefault(); window.p9.openLink?.(a.href); }; });
  const url = outer.$('#profileUrl'); if (!url) return;
  const http = () => { outer.$('#profileHttp').hidden = !/^http:/i.test(url.value.trim()); }; url.oninput = http; http();
  outer.$('#profileCancel').onclick = () => { profileForm = null; profileNote = ''; renderSettings(); };
  outer.$('#profileSave').onclick = async () => {
    const key = outer.$('#profileKey').value, command = outer.$('#profileCommand').value.trim();
    const body = { ...(profileForm !== 'new' && { id: profileForm }), name: outer.$('#profileName').value.trim(), baseUrl: url.value.trim(), models: outer.$('#profileModels').value.split('\n').map(m => m.trim()).filter(Boolean), ...(key && { key }), ...(command && { command }) };
    // A saved key belongs to the address it was typed for: the daemon drops it when the address changes, so ask here.
    const was = outer.profiles.find(x => x.id === profileForm), same = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
    if (was && was.secret !== 'none' && !key && !command && !same(body.baseUrl, was.baseUrl)) { profileNote = 'The base URL changed, so the saved key is not sent to the new address. Type the key for it, or the command that prints it.'; outer.$('#profileNote').textContent = profileNote; return; }
    const r = await window.p9.chat('profileSave', body).catch(() => null);
    if (r?.status !== 200) { profileNote = 'Not saved. It needs a name, an http or https address with no sign-in or query in it, 1 to 20 model names (letters, digits and . _ : / @ + -), and a key without spaces.'; outer.$('#profileNote').textContent = profileNote; return; }
    profileForm = null; profileNote = ''; await redraw();
  };
}
// The handlers of the three selects in each agent's defaults row (renderSettings, refreshDefaults).
function bindDefaults() {
  outer.$('#setBody').querySelectorAll('[data-default-mode]').forEach(el => { el.onchange = async () => {
    const a = el.dataset.defaultMode, m = el.value;
    if (LOOSE[m] && !localStorage.getItem('p9-mode-ok:' + m) && !await outer.looseOk(a, m)) { el.value = outer.defaultMode(a); return; }
    m ? localStorage.setItem('p9-mode-default:' + a, m) : localStorage.removeItem('p9-mode-default:' + a);
  }; });
  outer.$('#setBody').querySelectorAll('[data-default-model], [data-default-effort]').forEach(el => { el.onchange = () => {
    const k = el.dataset.defaultModel ? `p9-model-default:${el.dataset.defaultModel}` : `p9-effort-default:${el.dataset.defaultEffort}`;
    el.value ? localStorage.setItem(k, el.value) : localStorage.removeItem(k);
  }; });
}
// O47: the agents' lists arrived while Settings is open. Only the defaults rows are drawn again, never the page: a full
// redraw would drop what is being typed in any other box. A row whose select is in use is left as it is.
function refreshDefaults() {
  outer.$('#setBody').querySelectorAll('.set-defaults').forEach(row => { if (!row.contains(document.activeElement)) row.outerHTML = defaultsRow(row.querySelector('[data-default-mode]').dataset.defaultMode); });
  bindDefaults();
  if (!outer.$('#setDelegation')?.contains(document.activeElement)) drawDelegation();
}
function renderSettings() {
  const on = Object.values(outer.settings.focus).filter(Boolean).length;
  const box = (id, label, checked, note = '', disabled = false, tip = '', section = 'settings') => `<label class="set-row"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${label}</strong>${note ? `<span class="muted sm">${note}</span>` : ''}</span>${tip ? '<span class="spacer"></span>' + info(tip, section) : ''}</label>`;
  outer.$('#setBody').innerHTML = `<div class="set-row"><a data-slot="button" data-variant="outline" id="setDocs" href="https://github.com/JudgeBreddd/p9#readme" target="_blank" rel="noopener">P9 docs on GitHub</a><button data-slot="button" data-variant="outline" id="setAm">Anymouse</button>${window.p9?.chat ? '<button data-slot="button" data-variant="outline" id="setWel">Setup</button>' : ''}<span class="spacer"></span>${info('The P9 guide (opens on GitHub), Anymouse (a note to P9\'s makers: an idea, a bug or a gripe) and Setup (the first-start window again).', 'settings')}</div>`
    + (window.p9?.setSettings ? `<div class="set-row"><span><strong>Zoom</strong><span class="muted sm">Ctrl = and Ctrl - from the shell; Ctrl 0 resets</span></span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="icon-sm" id="zOut" title="Zoom out">−</button><span class="mono" id="zVal">${Math.round(outer.settings.zoom * 100)}%</span><button data-slot="button" data-variant="outline" data-size="icon-sm" id="zIn" title="Zoom in">+</button><button data-slot="button" data-variant="ghost" data-size="sm" id="zReset">Reset</button>${info('Makes everything in this window bigger or smaller, in every focus mode.', 'settings')}</div>` : '')
    + `<label class="set-row"><span><strong>Your name</strong><span class="muted sm">The landing page greets you with it. Empty: no name.</span></span><span class="spacer"></span><input data-slot="input" id="setName" maxlength="40" autocomplete="off" spellcheck="false">${info('The name the landing page greets you with.', 'settings')}</label>`
    + box('setStartLast', 'Start in my last focus mode', outer.settings.startLast, 'Skips the landing page when P9 opens. The Event Horizon mark, top left, still opens it.', false, 'P9 opens straight into the focus mode you used last (Chat Focus, Dev Focus or Mission Control), not the landing page.')
    + box('setCloseSend', 'Close the chat window on send', outer.settings.closeOnSend, 'A chat opened from a card or the Notification Center closes once your message is sent.', false, 'A chat window opened from a Chat Focus card or the Notification Center closes once you send your message.')
    // The daemon keeps this one (it starts the shells, the phone's too); null: it did not answer, so the box is disabled.
    + (window.p9?.terminal ? box('setGreeting', 'Show the shell\'s welcome message in terminals', outer.termGreeting !== false, outer.termGreeting === null ? 'P9 did not answer; try again in a moment.' : 'Off: new terminals skip the greeting fish prints (a logo or fastfetch) and get P9_NO_GREETING=1 for your shell config. PowerShell always starts without its logo.', outer.termGreeting === null, 'The welcome text a shell prints when a new P9 terminal opens. Terminals already open keep theirs.') : '')
    + `<fieldset class="set-group"><legend>New chats start in ${info('The mode a new chat starts in, per agent. Last mode picked: the mode you picked last in a chat. Full access and Bypass permissions ask first, in red, unless you ticked Don\'t show again for them; a loosened last pick does not start a new chat on its own. The agent lock still wins.', 'settings')}</legend>${Object.keys(modes).map(defaultsRow).join('')}</fieldset>`
    + profilesGroup()
    + delegationGroup()
    + `<fieldset class="set-group"><legend>Focus modes ${info('The three workspaces of P9: Chat Focus, Dev Focus and Mission Control. Turn off the ones you do not use; at least one stays on.', 'focus-modes')}</legend>${Object.entries(outer.focusNames).map(([f, n]) => box('setF-' + f, n, outer.settings.focus[f], '', outer.settings.focus[f] && on === 1)).join('')}</fieldset>`
    + (outer.pets ? petSettings() : '')
    + securityGroup(box)
    + (outer.missionFiles?.settings ? missionGroup() : '')
    + (outer.serverInfo ? serverRow() : '')
    + (window.p9?.xferPlan && outer.settings.xfer ? `<fieldset class="set-group"><legend>Send files ${info('Limits on one Send files to remote (the files panel\'s button): a send past one is refused before anything is copied, and the refusal names the limit.', 'send-files')}</legend>${Object.entries(outer.XFER_SETTINGS).map(([k, [label, unit, max]]) => `<label class="set-row"><span><strong>${label}</strong><span class="muted sm">${unit}, 1 to ${max.toLocaleString()}</span></span><span class="spacer"></span><input data-slot="input" type="number" min="1" max="${max}" step="1" id="setXfer-${k}" data-xfer-limit="${k}" value="${outer.settings.xfer[k]}" style="width:9em"></label>`).join('')}</fieldset>` : '')
    + maintenanceGroup(outer.updates);
  settingsPages();
  const zoom = z => saveSettings({ ...outer.settings, zoom: Math.round(Math.min(3, Math.max(0.5, z)) * 10) / 10 });
  if (outer.$('#zIn')) { outer.$('#zIn').onclick = () => zoom(outer.settings.zoom + 0.1); outer.$('#zOut').onclick = () => zoom(outer.settings.zoom - 0.1); outer.$('#zReset').onclick = () => zoom(1); }
  outer.$('#setName').value = outer.settings.name || '';
  outer.$('#setName').onchange = e => saveSettings({ ...outer.settings, name: e.target.value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40) });
  outer.$('#setStartLast').onchange = e => saveSettings({ ...outer.settings, startLast: e.target.checked });
  outer.$('#setBody').querySelectorAll('[data-xfer-limit]').forEach(el => { el.onchange = () => { const k = el.dataset.xferLimit, n = Math.round(Number(el.value));
    if (!Number.isFinite(n)) { el.value = outer.settings.xfer[k]; return; }
    saveSettings({ ...outer.settings, xfer: { ...outer.settings.xfer, [k]: Math.min(outer.XFER_SETTINGS[k][2], Math.max(1, n)) } }); }; });
  outer.$('#setCloseSend').onchange = e => saveSettings({ ...outer.settings, closeOnSend: e.target.checked });
  if (outer.$('#setGreeting')) outer.$('#setGreeting').onchange = async e => { const r = await window.p9.terminal('greeting', { show: e.target.checked }).catch(() => null); outer.termGreeting = r?.status === 200 ? r.body.show : null; renderSettings(); };
  bindDefaults(); bindProfiles(); bindDelegation();
  // 0.1.8: Open P9 on, kept by main in p9-server.json (openOn) and read the next time P9 starts.
  if (outer.$('#setOpenOn')) outer.$('#setOpenOn').onchange = async e => { const v = e.target.value, r = await window.p9.remotes('open-on', v === 'last' ? null : v === 'local' ? '' : v).catch(() => null); if (r) outer.serverInfo.openOn = r.openOn;
    else outer.toast({ kind: 'settings', txt: 'Not saved. P9 will open where it did before.', level: 'bad' }, true);
    // Saved or not, the row shows what is really kept: a failed save goes back, and a later save that lands after it shows its own value.
    const kept = outer.serverInfo.openOn; e.target.value = kept == null ? 'last' : kept === '' ? 'local' : kept; };
  if (outer.pets) wirePetSettings();
  if (outer.missionFiles?.settings) wireMission();
  // Main reloads the window onto the chosen daemon, so nothing here re-renders.
  outer.$('#setBody').querySelectorAll('[data-remote-go]').forEach(b => { b.onclick = () => window.p9.server(b.dataset.remoteGo); });
  const remotesNow = async (action, name) => { const r = await window.p9.remotes(action, name).catch(() => null); if (r) outer.serverInfo.remotes = r.remotes; renderSettings(); outer.serverMenu(); };
  outer.$('#setBody').querySelectorAll('[data-remote-remove]').forEach(b => { b.onclick = () => remotesNow('remove', b.dataset.remoteRemove); });
  outer.$('#setBody').querySelectorAll('[data-remote-keep]').forEach(s => { s.onchange = async () => {
    const r = await window.p9.remoteKeepSetting(s.dataset.remoteKeep, s.value === 'keep' ? true : s.value === 'stop' ? false : null).catch(() => null);
    if (r) outer.serverInfo.keep = r.keep;
  }; });
  // Row 79: a remote's key offer said Don't ask again; this offers it again after the next password login.
  outer.$('#setBody').querySelectorAll('[data-key-again]').forEach(b => { b.onclick = async () => {
    const r = await window.p9.sshKeySetting(b.dataset.keyAgain).catch(() => null);
    if (r) { outer.serverInfo.noKey = r.noKey; renderSettings(); }
  }; });
  if (outer.$('#setRemoteAdd')) outer.$('#setRemoteAdd').onsubmit = e => {
    e.preventDefault();
    const name = outer.$('#setRemoteName').value.trim(), err = outer.$('#setRemoteErr');
    // The same rule as main's (desktop/remote.mjs HOST); main checks again.
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/.test(name)) { err.hidden = false; err.textContent = 'A remote is a Host name from ~/.ssh/config or user@address: letters, digits and . _ - @, starting with a letter or digit.'; return; }
    remotesNow('add', name);
  };
  if (outer.$('#setServerLocal')) outer.$('#setServerLocal').onclick = () => window.p9.server(null);
  Object.keys(outer.focusNames).forEach(f => { outer.$('#setF-' + f).onchange = e => saveSettings({ ...outer.settings, focus: { ...outer.settings.focus, [f]: e.target.checked } }); });
  if (outer.$('#setLock')) outer.$('#setLock').onchange = async e => { const r = await outer.liveChat.call('setLock', { on: e.target.checked }); outer.agentLock = r.status === 200 ? r.body.on : outer.agentLock; renderSettings(); };
  // Main shows the warning when this turns it off; the box then shows what the daemon says, so a "Keep" answer re-checks it.
  if (outer.$('#setProtect')) outer.$('#setProtect').onchange = async e => { const r = await window.p9.fileProtection(e.target.checked).catch(() => null); outer.fileProtect = r?.status === 200 ? r.body.on : outer.fileProtect; renderSettings(); };
  outer.$('#setWarn').onchange = e => { setWarnsLoose(e.target.checked); renderSettings(); };
  if (outer.$('#setLinks')) outer.$('#setLinks').onchange = e => { e.target.checked ? localStorage.removeItem('p9-link-ok') : localStorage.setItem('p9-link-ok', '1'); renderSettings(); };
  if (outer.$('#setFree')) outer.$('#setFree').onchange = e => setUnrestricted(e.target.checked);
  outer.$('#setDocs').onclick = e => { if (window.p9?.openDocs) { e.preventDefault(); window.p9.openDocs(); } }; // a browser preview follows the link
  outer.$('#setAm').onclick = () => { outer.$('#setDlg').close(); outer.$('#amBtn').click(); };
  if (outer.$('#setWel')) outer.$('#setWel').onclick = () => { outer.$('#setDlg').close(); welcome(); };
  MAINTENANCE.forEach(m => { if (outer.$('#' + m.id)) outer.$('#' + m.id).onclick = outer.maintain[m.id]; });
  const asked = async ask => { outer.updates = await window.p9.updates(ask).catch(() => outer.updates); renderSettings(); };
  if (outer.$('#mtUpdCheck')) outer.$('#mtUpdCheck').onclick = () => asked({ check: true });
  if (outer.$('#mtUpdInstall')) outer.$('#mtUpdInstall').onclick = () => asked({ install: true });
  if (outer.$('#mtUpdNightly')) outer.$('#mtUpdNightly').onchange = e => asked({ nightly: e.target.checked });
  if (outer.$('#mtUpdOpen')) outer.$('#mtUpdOpen').onclick = () => window.p9.openUpdates();
  clearTimeout(outer.updatesTimer); // a check or download in progress: show its next state while Settings is open
  if (['checking', 'downloading'].includes(outer.updates?.state)) outer.updatesTimer = outer.setTimeout(() => { if (outer.$('#setDlg').open) asked(); }, 2000);
  // HI1: an "i" shows its tip on hover and opens its part of the guide on click (main allows only the guide's sections).
  outer.$('#setBody').querySelectorAll('[data-docs]').forEach(b => { b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    window.p9?.openDocs?.(b.dataset.docs).catch(() => {}); // a browser preview: the tip only
  }; });
}
async function loadSetup(paths) {
  if (!window.p9?.chat) return null;
  // D15a: a remote that is not answering (no P9 there yet) has no setup to read: none is asked, and no toast.
  const st = await window.p9.getStatus?.().catch(() => null);
  outer.setupMode = st?.mode ?? '';
  if (st?.mode === 'server' && st.status !== 'ok') return null;
  // No toast either when this computer's P9 does not answer: the wizard shows the failure, the status line the daemon.
  const r = await outer.liveChat.call('setup', paths || {}, { quiet: true }).catch(() => null);
  return r?.status === 200 ? r.body : null;
}
// The four checks the card counts. Off Linux tmux is null and counts as done: the dock's terminals are tmux there only.
// pick (item 15): an agent installed or signed in; while it is false the wizard asks Claude, Codex or both first. The
// card leaves it out: a missing pick is a missing sign-in too.
function setupDone(s) { return { workspace: s.writable, pick: s.claudeCli || s.codexCli || s.claude || s.codex, agents: s.claude || s.codex, mission: (!s.settingsPresent && !s.found?.registry && !s.found?.waiting) || s.settings && s.agentsFile !== false && s.registryFile !== false && !(s.agentsFile === null && s.registryFile === null && (s.found?.registry || s.found?.waiting)), terminal: s.tmux !== false }; }
function welSkipped() { try { return localStorage.getItem('p9-welcome-skipped') === '1'; } catch { return false; } }
// Item 15: the agents the wizard offers, each with the one line that says what it needs.
const AGENTS_PICK = [['claude', 'Claude', 'Claude Code, by Anthropic. Needs a Claude account (Pro, Max or Team) or an API key.'], ['codex', 'Codex', 'Codex, by OpenAI. Needs a ChatGPT account (Plus, Pro or Business) or an API key.']];
// What the pick step shows as picked: this run's choice, else what is installed or signed in already.
const wizPicked = () => W.picked || AGENTS_PICK.filter(([a]) => W.s?.[a + 'Cli'] || W.s?.[a]).map(([a]) => a);
const wizReady = () => { const on = wizPicked(); return on.length > 0 && on.every(a => W.s?.[a + 'Cli']); };
// The admin screen's name for each system item /setup can report missing (deps.mjs wizardDependencies).
const ADMIN_NAMES = { tmux: 'tmux', ssh: 'SSH client' };
const STEP_NAMES = { workspace: 'workspace folder', agents: 'agent sign-in', mission: 'Mission Control files', terminal: 'terminal' };
async function checkSetup() {
  const s = await loadSetup();
  outer.S.setup = s && Object.values(setupDone(s)).includes(false) ? s : null;
  outer.renderCards();
}
function skipWelcome() { try { localStorage.setItem('p9-welcome-skipped', '1'); } catch {} outer.renderCards(); }
function tour() { const from = outer.S.focus; outer.setFocus('chat', true); outer.walkthrough(0, from); }
// First run (the landing page closed for the first time): the wizard while a check fails, then the walkthrough.
async function firstRun() {
  const s = await loadSetup();
  if (!s || welSkipped() || !Object.values(setupDone(s)).includes(false)) return tour();
  W.then = tour; welcome(0);
}
const W = { i: 0, s: null, login: {}, timer: 0, note: {}, code: '', name: null, busy: '', then: null, paths: null, picked: null, have: null };
// The paths the wizard would write: the owner's edits, else what the daemon proposed (what it found, filled in with the
// starter paths). Empty fields are left out.
const wizPaths = () => Object.fromEntries(Object.entries(W.paths || (W.s?.conflict ? W.s.proposed : W.s?.found) || {}).filter(([k, v]) => PATH_KEYS.some(([key]) => key === k) && v));
const wizChoosing = s => s && ((!s.settings && !s.settingsPresent) || s.conflict || (s.settings && s.agentsFile === null && s.registryFile === null));
// Fresh-install attempt 2, item 8: Mission Control is the last step, once everything else is set up; its button opens
// Mission's own onboarding card.
const wizSteps = () => ['welcome', 'workspace', 'pick', 'agents', ...(W.s?.tmux === null ? [] : ['terminal']), 'you', 'done', 'mission'];
// D17: stale = the chat said this agent is not signed in. Its login file can outlive the login, so /setup still says
// signed in; the step believes the chat until a sign-in started here ends well.
async function welcome(at, agent, stale) {
  if (!window.p9?.chat) return; // a browser preview has no daemon to set up
  Object.assign(W, { note: {}, code: '', name: null, busy: '', paths: null, have: null, remote: false, hosts: null, picked: null, stale: stale ? agent : null, began: null });
  W.s = await loadSetup();
  if (agent) W.picked = [...new Set([...wizPicked(), agent])];
  const d = W.s && setupDone(W.s);
  W.i = typeof at === 'string' ? Math.max(0, wizSteps().indexOf(at)) : at ?? Math.max(0, d ? wizSteps().findIndex(k => d[k] === false) : 0);
  // BL5: every 10 s (was 2 s) while a check fails or a sign-in runs; wizRefresh stops it once neither is so, and starts it again.
  clearInterval(W.timer); W.timer = setInterval(wizRefresh, 10000);
  await wizRefresh();
  if (!outer.$('#welDlg').open) outer.$('#welDlg').showModal();
}
async function wizRefresh() {
  const [s, l] = await Promise.all([loadSetup(W.paths && wizPaths()), window.p9.agentLogin('state').catch(() => null)]);
  W.s = s; W.login = l?.status === 200 ? l.body : {};
  const began = W.login[W.began];
  if (began && !began.running) { if (began.exit === 0 && W.stale === W.began) W.stale = null; W.began = null; }
  if (s) { outer.S.setup = Object.values(setupDone(s)).includes(false) ? s : null; outer.renderCards(); }
  if (s && !outer.S.setup && !Object.values(W.login).some(l => l?.running)) { clearInterval(W.timer); W.timer = 0; }
  else if (!W.timer && outer.$('#welDlg').open) W.timer = setInterval(wizRefresh, 10000); // a sign-in started after setup was done
  outer.wizRender();
}
// Each error a step can get back, as [cause, fix].
const WIZ_ERR = {
  'daemon-unavailable': ["P9's background service is not answering.", 'It restarts on its own. Retry in a few seconds.'],
  'daemon-outdated': ["P9's background service is older than this app, so it does not have this step.", 'Update P9 where its background service runs (or restart that service after an update), then try again.'],
  'workspace-change-unsupported': ["On this system the folder can't be changed from here.", 'P9 changes it on Linux and Windows.'],
  'workspace-refused': ["That folder can't be the workspace.", "Pick a folder of your own: not your home folder itself, a drive's root or P9's own state folder."],
  'service-missing': ["P9's background service is not installed.", "Run P9's installer again (the README's Install section), then Retry."],
  'dev-task-missing': ["This window runs on a second (dev) P9 that has no Windows task of its own yet, so P9 left the daily one alone.", 'Set up its task with install-windows.ps1 -Unit (for example -Unit p9-dev), then Retry.'],
  'stop-all-failed': ['Something running would not stop, so the folder stayed the same.', 'Stop it in Chat or the terminal dock, then Change the folder again.'],
  'workspace-not-started': ['P9 could not start in that folder, so it went back to the one it was on.', 'Pick another folder.'],
  'workspace-unwritable': ['P9 cannot write to this folder.', 'Change the folder, or give your user write access to this one, then Retry.'],
  'terminal-start-failed': ['The terminal did not open.', 'Retry, or open a terminal of your own and run the command shown.'],
  'terminal-unavailable': ['The terminal did not open.', 'Retry, or open a terminal of your own and run the command shown.'],
  'stop-all-running': ['Stop all is still running.', 'Retry when it is done.'],
  updating: ['P9 is updating and restarts in a moment.', 'Send again in a minute.'],
  'tmux-not-found': ['tmux is not installed.', 'P9 does not know this system\'s package manager, so someone who administers it must install tmux, then Retry. The rest of P9 works without it.'],
  'agents-not-installed': ['P9 could not put the agent where its terminals find it.', 'Continue without it goes on: chats still work, they use the agent P9 ships.'],
  'nothing-to-install': ['That is installed now.', 'Retry checks again.'],
  'wrong-password': ['That password did not work.', 'Check it and press Install again.'],
  'not-allowed': ['Your account cannot install software on this computer.', 'Someone who administers it must install it, then Retry.'],
  'remote-deps-failed': ['P9 on this remote could not check what it needs.', 'Update P9 there, then Retry.'],
  'remote-not-allowed': ['Your account on this remote cannot install software.', 'Someone who administers it must install it, then Retry.'],
  'admin-failed': ['The install did not finish.', 'Retry. If it stops again, your package manager may be busy or offline.'],
  'password-empty': ['Type your admin password first.', 'It is the one you use to sign in to this computer.'],
  'login-running': ['A sign-in is already running.', 'Finish it in your browser, or Cancel it and sign in again.'],
  'login-not-running': ['That sign-in has ended.', 'Sign in again.'],
  'no-sign-in-page': ['The sign-in has not shown its page yet.', 'Wait a few seconds, then try again.'],
  'request-refused': ['That code has characters a sign-in code never has.', 'Copy the code again from the browser and paste only the code.'],
  'shutting-down': ["P9's background service is restarting.", 'Retry in a few seconds.'],
  'settings-file-unknown': ['P9 does not know where its settings file goes.', 'Restart P9, then Retry.'],
  'settings-changed': ['Something else wrote the settings file just now.', 'Retry reads it again.'],
  'settings-invalid': ['Your settings file has an error.', 'Fix it in a text editor, or delete it, then Retry. P9 never changes a file it cannot read.'],
  'paths-required': ['This folder already has things in it, so P9 needs the paths to use.', 'Check the paths above, then Create again.'],
  'paths-invalid': ['A path is not one P9 can use.', 'Each is inside the workspace, written with / and without .. (for example docs/AGENTS.md).'],
  'settings-exist': ['A settings file appeared meanwhile, so nothing was written.', 'Retry reads it.'],
  'pick-outside': ['That is outside the workspace.', 'Pick a file or folder inside it.'],
  'pick-root': ['That is the workspace folder itself.', 'Pick a file or folder inside it.'],
  'server-mode-local-only': ["That changes this computer's P9, and this window is working on a remote.", 'Switch to Local (the top-bar badge or Settings > Remote Connect), then try again.'],
  'path-is-a-file': ['That path names a file where P9 needs a folder.', 'Pick a folder for it, or move that file out of the way, then Create again.'],
};
// The hosts are the Host lines of ~/.ssh/config (W.hosts, read when the choice opens); connecting reloads this window onto that P9.
// Attempt 2 items 1-2: the wizard connects itself. One field: a remote already used, a Host from ~/.ssh/config, or a new
// user@address (kept in Settings > Remote's list too). A password, if ssh needs one, is asked in its own window (row 78).
function wizRemote(btn) {
  const h = W.hosts, hosts = [...new Set([...(h?.remotes || []), ...(h?.hosts || [])])], opts = hosts.map(x => '<option value="' + esc(x) + '"></option>').join('');
  return '<div data-wiz-remote>'
    + `<div class="set-row"><span><strong>Which remote</strong><span class="muted sm">A Host name from your ssh config, or user@address. If ssh asks for a password, P9 asks you for it in its own window and never saves it.</span></span><span class="spacer"></span><input data-slot="input" id="welHost" list="welHosts" value="${esc(h?.last || hosts[0] || '')}" placeholder="user@address" aria-label="Remote to connect to" maxlength="253" autocomplete="off" spellcheck="false"><datalist id="welHosts">${opts}</datalist>${btn('connect', 'Connect', 'default')}</div>`
    + (W.note.remote?.error ? `<p class="warn sm" role="alert">${W.note.remote.error === 'host' ? 'Type a Host name or user@address, with no spaces.' : 'Could not connect (' + esc(W.note.remote.error) + ').'}</p>` : '') + '</div>';
}
  return { saveSettings, applySettings, settingsAt, renderSettings, refreshDefaults, loadSetup, setupDone, welSkipped, AGENTS_PICK, wizPicked, wizReady, ADMIN_NAMES, STEP_NAMES, checkSetup, skipWelcome, tour, firstRun, W, wizPaths, wizChoosing, wizSteps, welcome, wizRefresh, WIZ_ERR, wizRemote };
}
