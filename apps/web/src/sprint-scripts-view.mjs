// The Sprint scripts window (S18; SECURITY.md § Sprint scripts, "The library"), for projects-view.mjs. Loaded on first
// use, so its code is not parsed at startup (test/shell-bundle.test.mjs).
// One window for a sprint's scripts and the owner's library: the rows the agent's tools read and write (sprint_scripts,
// sprint_script_save, _remove, _add, run_sprint_script). P9 checks every row it is sent; a script runs only in the copy
// Start approved, so Run now is offered on those rows alone.
// d: projects-view's own { cur: () => the shown project, esc, scriptLine, scriptsOf, call, failed, ERR, say, adopt, renderPage, fillBox }.
export function installScripts(d) {
  const { esc, scriptLine, scriptsOf, call, failed, ERR, say, adopt, renderPage, fillBox } = d;
  const sdlg = document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'pjScripts', className: 'pj-dlg pj-scripts' }));
  sdlg.setAttribute('aria-labelledby', 'pjScriptsT');
  // Redrawn while open, so into its own box: the toast list lives in the open window (controller.mjs, D7) and must stay.
  const sbox = sdlg.appendChild(Object.assign(document.createElement('div'), { className: 'ss' }));
  let ss = null; // the open window: { lead, library, points, blocking, form, said, bad, busy }
  const ssList = (rows, where, acts, none) => rows.length ? `<ul class="ss-list">${rows.map(s => `<li data-ss-row="${where}" data-name="${esc(s.name)}"><span class="mono">${esc(scriptLine(s))}</span><span class="acts">${acts.map(([k, t]) =>
    `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-ss="${k}" data-name="${esc(s.name)}"${ss.busy ? ' disabled' : ''}>${t}</button>`).join('')}</span></li>`).join('')}</ul>` : `<p class="quiet">${none}</p>`;
  function drawScripts() {
    const sp = d.cur()?.sprints?.find(x => x.lead === ss?.lead); if (!sp) { if (sdlg.open) sdlg.close(); ss = null; return; }
    const file = scriptsOf(sp), ok = sp.started?.scripts ?? [], f = ss.form, off = ss.busy ? ' disabled' : '';
    sbox.innerHTML = `<h2 id="pjScriptsT">Sprint scripts: ${esc(sp.title)}</h2>
      <p class="quiet">A script is a command P9 runs as you at a point in the sprint, outside every agent's mode. P9 runs only the copies you approved by pressing Start sprint. You and the sprint's agents can both write these rows.</p>
      <section data-ss-sec="approved"><h3>Approved at Start</h3>${ssList(ok, 'approved', [['run', 'Run now']], sp.started ? 'None: the Start you pressed had no scripts.' : 'None yet: nothing is approved before Start sprint.')}</section>
      <section data-ss-sec="sprint"><h3>In this sprint (hooks.json)</h3>${file === null ? '<p class="quiet" role="alert">hooks.json is not a scripts list. Fix or empty the file first.</p>'
        : ssList(file, 'sprint', [['edit', 'Edit'], ['tolib', 'Save to library'], ['rm', 'Remove']], 'No scripts in this sprint.')}</section>
      <section data-ss-sec="library"><h3>Your library, for any sprint in any project</h3>${ssList(ss.library, 'library', [['libedit', 'Edit'], ['add', 'Add to sprint'], ['librm', 'Remove']], 'Nothing saved yet.')}</section>
      <section class="ss-form" aria-label="A script"><label>Name<input data-slot="input" name="name" value="${esc(f.name)}" maxlength="60" autocomplete="off" spellcheck="false"></label>
        <label>When<select data-slot="select" name="point">${ss.points.map(p => `<option${p === f.point ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
        <label class="wide">Command<input data-slot="input" class="mono" name="command" value="${esc(f.command)}" maxlength="200" autocomplete="off" spellcheck="false" placeholder="/path/to/program argument"></label>
        <label class="chk wide"><input type="checkbox" name="blocking"${f.blocking && ss.blocking.includes(f.point) ? ' checked' : ''}${ss.blocking.includes(f.point) ? '' : ' disabled'}>Blocking: a failure refuses the step (only before a step)</label></section>
      <p class="said${ss.bad ? ' err' : ''}" data-ss-said role="status">${esc(ss.said)}</p>
      <div class="btns"><button type="button" data-slot="button" data-variant="ghost" data-ss="close">Close</button><button type="button" data-slot="button" data-variant="outline" data-ss="savelib"${off}>Save to library</button><button type="button" data-slot="button" data-variant="default" data-ss="save"${off}>Save to sprint</button></div>`;
  }
  async function show(lead) {
    const r = await call('scriptLibrary', {}, { quiet: true }); if (r.status !== 200) return failed(r);
    ss = { lead, library: r.body.library, points: r.body.points, blocking: r.body.blocking, form: { name: '', command: '', point: r.body.points[0], blocking: false }, said: '', bad: false, busy: false };
    drawScripts(); if (ss && !sdlg.open) sdlg.showModal();
  }
  sdlg.addEventListener('close', () => { ss = null; });
  // What is typed stays through a redraw; Blocking is offered only at the points that can refuse a step.
  sdlg.addEventListener('input', e => { if (!ss || !e.target.name) return; const q = n => sdlg.querySelector(`[name=${n}]`), at = q('point').value;
    q('blocking').disabled = !ss.blocking.includes(at); if (q('blocking').disabled) q('blocking').checked = false;
    ss.form = { name: q('name').value, command: q('command').value, point: at, blocking: q('blocking').checked }; });
  sdlg.addEventListener('click', async e => {
    const b = e.target.closest('[data-ss]'); if (!b || !ss) return;
    const k = b.dataset.ss, name = b.dataset.name, mine = ss, lead = ss.lead, id = d.cur()?.id, sp = d.cur()?.sprints?.find(x => x.lead === lead);
    if (k === 'close') return sdlg.close();
    if (ss.busy || !sp) return;
    const row = (k === 'libedit' ? ss.library : scriptsOf(sp) ?? []).find(s => s.name === name);
    if (k === 'edit' || k === 'libedit') { if (row) ss.form = { name: row.name, command: row.command, point: row.point, blocking: row.blocking === true }; ss.said = ''; ss.bad = false; drawScripts(); return sdlg.querySelector('[name=command]').focus(); }
    const f = ss.form, typed = { name: f.name.trim(), command: f.command.trim(), point: f.point, ...(f.blocking && ss.blocking.includes(f.point) && { blocking: true }) };
    const later = r => r.body.pending ? ' Not run until you press Start sprint, which approves it.' : '';
    const [action, body, done] = k === 'save' ? ['saveScript', { script: typed, sprint: lead }, r => `In this sprint: ${typed.name}.${later(r)}`]
      : k === 'savelib' ? ['saveScript', { script: typed }, () => `In your library: ${typed.name}.`]
      : k === 'tolib' ? ['saveScript', { script: row ?? {} }, () => `In your library: ${name}.`]
      : k === 'rm' ? ['removeScript', { name, sprint: lead }, () => `Removed from this sprint: ${name}. An approved copy still runs until you press Start sprint again.`]
      : k === 'librm' ? ['removeScript', { name }, () => `Removed from your library: ${name}. Sprints that took a copy keep it.`]
      : k === 'add' ? ['addScript', { name, sprint: lead }, r => `In this sprint: ${name}.${later(r)}`]
      : ['runSprintScript', { sprint: lead, name }, r => `Ran ${name}: ${r.body.reason || 'exit ' + r.body.exit} in ${r.body.ms} ms${r.body.line ? ', it said: ' + r.body.line : ''}. The run is in hooks.log.`];
    ss.busy = true; ss.bad = false; ss.said = k === 'run' ? `Running ${name}…` : ''; drawScripts();
    const r = await call(action, body, { quiet: true }).catch(() => ({ status: 0, body: {} })), good = r.status === 200;
    const said = good ? done(r) : 'Not done: ' + (r.body?.detail || ERR[r.body?.error] || r.body?.error || 'P9 did not answer') + (r.body?.detail ? '' : '.');
    if (good && r.body.library) mine.library = r.body.library;
    // The sprint's files changed (hooks.json, or hooks.log after a run): the page reads them again, in place.
    if (good && !r.body.library) { const again = d.cur()?.id === id && await call('project', { id }, { quiet: true }); if (again?.status === 200 && d.cur()?.id === id) { adopt(again.body.project, lead); renderPage(); fillBox(false); } }
    mine.busy = false; mine.said = said; mine.bad = !good;
    if (ss === mine) drawScripts(); else if (k === 'run') say(said, good ? 'ok' : 'warn'); // closed while it ran: the answer still shows
  });
  return { show };
}
