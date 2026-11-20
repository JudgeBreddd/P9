// The Sprint scripts window (S18; SECURITY.md § Sprint scripts, "The library"), for projects-view.mjs. Loaded on first
// use, so its code is not parsed at startup (test/shell-bundle.test.mjs).
// One window for a sprint's scripts and the owner's library: the rows the agent's tools read and write (sprint_scripts,
// sprint_script_save, _remove, _add, run_sprint_script). P9 checks every row it is sent; a script runs only in a copy
// that stands (approved at Start, or after it: S20, "Scripts added after Start"), so Run now is offered on those rows alone.
// d: projects-view's own { cur: () => the shown project, esc, scriptLine, scriptsOf, call, failed, ERR, say, adopt, renderPage, fillBox }.
export function installScripts(d) {
  const { esc, scriptLine, scriptsOf, call, failed, ERR, say, adopt, renderPage, fillBox } = d;
  const sdlg = document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'pjScripts', className: 'pj-dlg pj-scripts' }));
  sdlg.setAttribute('aria-labelledby', 'pjScriptsT');
  // Redrawn while open, so into its own box: the toast list lives in the open window (controller.mjs, D7) and must stay.
  const sbox = sdlg.appendChild(Object.assign(document.createElement('div'), { className: 'ss' }));
  let ss = null; // the open window: { lead, library, points, blocking, form, said, bad, busy, allowed, additional, waiting, hash, warn }
  const ssList = (rows, where, acts, none) => rows.length ? `<ul class="ss-list">${rows.map(s => `<li data-ss-row="${where}" data-name="${esc(s.name)}"><span class="mono">${esc(scriptLine(s))}</span><span class="acts">${acts.map(([k, t]) =>
    `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-ss="${k}" data-name="${esc(s.name)}"${ss.busy ? ' disabled' : ''}>${t}</button>`).join('')}</span></li>`).join('')}</ul>` : `<p class="quiet">${none}</p>`;
  function drawScripts() {
    const sp = d.cur()?.sprints?.find(x => x.lead === ss?.lead); if (!sp) { if (sdlg.open) sdlg.close(); ss = null; return; }
    const file = scriptsOf(sp), ok = sp.started?.scripts ?? [], f = ss.form, off = ss.busy ? ' disabled' : '';
    sbox.innerHTML = `<h2 id="pjScriptsT">Sprint scripts: ${esc(sp.title)}</h2>
      <p class="quiet">A script is a command P9 runs as you at a point in the sprint, outside every agent's mode. P9 runs the copies you approved by pressing Start sprint; what is added later is under Added after Start. You and the sprint's agents can both write these rows.</p>
      <section data-ss-sec="approved"><h3>Approved at Start</h3>${ssList(ok, 'approved', [['run', 'Run now']], sp.started ? 'None: the Start you pressed had no scripts.' : 'None yet: nothing is approved before Start sprint.')}</section>
      ${sp.started ? `<section data-ss-sec="later"><h3>Added after Start</h3>
        <label class="chk"><input type="checkbox" data-ss="allow"${ss.allowed ? ' checked' : ''}${off}>Allow additional scripts</label>
        <p class="quiet">${ss.allowed ? 'On, for every sprint: a script added or changed in a started sprint runs at its point with no question.' : 'Off: a script added or changed in a started sprint waits here until you approve it. An agent can ask you to; it cannot turn this on.'}</p>
        ${ss.warn ? `<div class="ss-warn" data-ss-warn role="alert"><p>With this on, any script an agent adds to a started sprint runs as you, outside every agent's mode, without asking you first. It holds for every sprint until you turn it off.</p>
          <span class="acts"><button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-ss="allowno"${off}>Keep off</button><button type="button" data-slot="button" data-variant="outline" data-size="sm" data-ss="allowon"${off}>Turn on</button></span></div>` : ''}
        ${ss.additional.length ? `<h4>Running</h4>${ssList(ss.additional, 'additional', [['run', 'Run now']], '')}` : ''}
        ${ss.waiting.length ? `<h4>Waiting for you</h4>${ssList(ss.waiting, 'waiting', [['approve', 'Approve']], '')}${ss.waiting.length > 1 ? `<span class="acts"><button type="button" data-slot="button" data-variant="outline" data-size="sm" data-ss="approveall"${off}>Approve all</button></span>` : ''}` : ''}
        ${!ss.additional.length && !ss.waiting.length ? '<p class="quiet">Nothing added since Start.</p>' : ''}</section>` : ''}
      <section data-ss-sec="sprint"><h3>In this sprint (hooks.json)</h3>${file === null ? '<p class="quiet" role="alert">hooks.json is not a scripts list. Fix or empty the file first.</p>'
        : ssList(file, 'sprint', [['edit', 'Edit'], ['tolib', 'Save to library'], ['rm', 'Remove']], 'No scripts in this sprint.')}</section>
      <section data-ss-sec="library"><h3>Your library, for any sprint in any project</h3>${ssList(ss.library, 'library', [['libedit', 'Edit'], ['add', 'Add to sprint'], ['librm', 'Remove']], 'Nothing saved yet.')}</section>
      <section class="ss-form" aria-label="A script"><label>Name<input data-slot="input" name="name" value="${esc(f.name)}" maxlength="60" autocomplete="off" spellcheck="false"></label>
        <label>When<select data-slot="select" name="point">${ss.points.map(p => `<option${p === f.point ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
        <label>Every (minutes)<input data-slot="input" type="number" name="every" min="10" max="120" step="1" value="${esc(f.every)}"${f.point === 'every' ? '' : ' disabled'}></label>
        <label class="wide">Command<input data-slot="input" class="mono" name="command" value="${esc(f.command)}" maxlength="200" autocomplete="off" spellcheck="false" placeholder="/path/to/program argument"></label>
        <label class="chk wide"><input type="checkbox" name="blocking"${f.blocking && ss.blocking.includes(f.point) ? ' checked' : ''}${ss.blocking.includes(f.point) ? '' : ' disabled'}>Blocking: a failure refuses the step (only before a step)</label></section>
      <p class="said${ss.bad ? ' err' : ''}" data-ss-said role="status">${esc(ss.said)}</p>
      <div class="btns"><button type="button" data-slot="button" data-variant="ghost" data-ss="close">Close</button><button type="button" data-slot="button" data-variant="outline" data-ss="savelib"${off}>Save to library</button><button type="button" data-slot="button" data-variant="default" data-ss="save"${off}>Save to sprint</button></div>`;
  }
  // What stands in a started sprint (S20, SECURITY.md "Scripts added after Start"): the switch, the rows running since
  // Start, the rows waiting, and the hash of the hooks.json they were read from (Approve sends it back).
  const stands = b => ({ allowed: b.allowed === true, additional: b.additional ?? [], waiting: b.waiting ?? [], hash: b.hash ?? '' });
  async function show(lead) {
    const r = await call('scriptLibrary', { sprint: lead }, { quiet: true }); if (r.status !== 200) return failed(r);
    ss = { lead, library: r.body.library, points: r.body.points, blocking: r.body.blocking, ...stands(r.body), warn: false, form: { name: '', command: '', point: r.body.points[0], blocking: false, every: '' }, said: '', bad: false, busy: false };
    drawScripts(); if (ss && !sdlg.open) sdlg.showModal();
  }
  sdlg.addEventListener('close', () => { ss = null; });
  // What is typed stays through a redraw; Blocking is offered only at the points that can refuse a step, Every only at every (O189).
  sdlg.addEventListener('input', e => { if (!ss || !e.target.name) return; const q = n => sdlg.querySelector(`[name=${n}]`), at = q('point').value;
    q('blocking').disabled = !ss.blocking.includes(at); if (q('blocking').disabled) q('blocking').checked = false; q('every').disabled = at !== 'every';
    ss.form = { name: q('name').value, command: q('command').value, point: at, blocking: q('blocking').checked, every: q('every').value }; });
  sdlg.addEventListener('click', async e => {
    const b = e.target.closest('[data-ss]'); if (!b || !ss) return;
    const k = b.dataset.ss, name = b.dataset.name, mine = ss, lead = ss.lead, id = d.cur()?.id, sp = d.cur()?.sprints?.find(x => x.lead === lead);
    if (k === 'close') return sdlg.close();
    if (ss.busy || !sp) return;
    const row = (k === 'libedit' ? ss.library : scriptsOf(sp) ?? []).find(s => s.name === name);
    if (k === 'edit' || k === 'libedit') { if (row) ss.form = { name: row.name, command: row.command, point: row.point, blocking: row.blocking === true, every: String(row.every ?? '') }; ss.said = ''; ss.bad = false; drawScripts(); return sdlg.querySelector('[name=command]').focus(); }
    const f = ss.form, typed = { name: f.name.trim(), command: f.command.trim(), point: f.point, ...(f.blocking && ss.blocking.includes(f.point) && { blocking: true }), ...(f.point === 'every' && { every: Number(f.every) }) };
    if (k === 'allow' && !ss.allowed) { ss.warn = true; ss.said = ''; ss.bad = false; return drawScripts(); } // on is asked first; off is not
    if (k === 'allowno') { ss.warn = false; return drawScripts(); }
    // Said after what stands is read again: waiting is the daemon's word, not a guess from the switch.
    const later = (r, n) => !r.body.pending ? '' : !sp.started ? ' Not run until you press Start sprint, which approves it.' : mine.waiting.some(w => w.name === n) ? ' It waits under Added after Start until you approve it.' : ' It runs from now on.';
    const okd = r => r.body.approved.length ? `Approved: ${r.body.approved.map(a => a.name).join(', ')}. ${r.body.approved.length > 1 ? 'They run at their points' : 'It runs at its point'} from now on.` : 'Nothing was waiting.';
    const [action, body, done] = k === 'save' ? ['saveScript', { script: typed, sprint: lead }, r => `In this sprint: ${typed.name}.${later(r, typed.name)}`]
      : k === 'savelib' ? ['saveScript', { script: typed }, () => `In your library: ${typed.name}.`]
      : k === 'tolib' ? ['saveScript', { script: row ?? {} }, () => `In your library: ${name}.`]
      : k === 'rm' ? ['removeScript', { name, sprint: lead }, () => `Removed from this sprint: ${name}. An approved copy still runs until you press Start sprint again.`]
      : k === 'librm' ? ['removeScript', { name }, () => `Removed from your library: ${name}. Sprints that took a copy keep it.`]
      : k === 'allow' ? ['allowScripts', { on: false }, () => 'Allow additional scripts is off. What ran only because it was on now waits.']
      : k === 'allowon' ? ['allowScripts', { on: true }, () => 'Allow additional scripts is on, for every sprint.']
      : k === 'approve' ? ['approveScripts', { sprint: lead, hash: ss.hash, names: [name] }, okd]
      : k === 'approveall' ? ['approveScripts', { sprint: lead, hash: ss.hash }, okd]
      : k === 'add' ? ['addScript', { name, sprint: lead }, r => `In this sprint: ${name}.${later(r, name)}`]
      : ['runSprintScript', { sprint: lead, name }, r => `Ran ${name}: ${r.body.reason || 'exit ' + r.body.exit} in ${r.body.ms} ms${r.body.line ? ', it said: ' + r.body.line : ''}. The run is in hooks.log.`];
    ss.busy = true; ss.warn = false; ss.bad = false; ss.said = k === 'run' ? `Running ${name}…` : ''; drawScripts();
    const r = await call(action, body, { quiet: true }).catch(() => ({ status: 0, body: {} })), good = r.status === 200;
    if (good && r.body.library) mine.library = r.body.library;
    // The sprint's files changed (hooks.json, or hooks.log after a run): the page reads them again, in place.
    if (good && !r.body.library) { const again = d.cur()?.id === id && await call('project', { id }, { quiet: true }); if (again?.status === 200 && d.cur()?.id === id) { adopt(again.body.project, lead); renderPage(); fillBox(false); } }
    const st = await call('scriptLibrary', { sprint: lead }, { quiet: true }).catch(() => null); if (st?.status === 200) Object.assign(mine, stands(st.body)); // also after a refusal: the hash may be old
    const said = good ? done(r) : 'Not done: ' + (r.body?.detail || ERR[r.body?.error] || r.body?.error || 'P9 did not answer') + (r.body?.detail ? '' : '.');
    mine.busy = false; mine.said = said; mine.bad = !good;
    if (ss === mine) drawScripts(); else if (k === 'run') say(said, good ? 'ok' : 'warn'); // closed while it ran: the answer still shows
  });
  return { show };
}
