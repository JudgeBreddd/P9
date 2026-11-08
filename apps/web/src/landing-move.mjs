// The landing page and the move animation. Split out of controller.mjs's mountShell (F9) with no change in behaviour; names that stay in mountShell come in through outer.

export function installLanding(outer) {
const NO_SKY = { ok: false, set() {}, frame() {}, size() {} };
const lastFocus = () => { let f = null; try { f = localStorage.getItem('p9-last-focus'); } catch {} return outer.focusOn(f) ? f : Object.keys(outer.focusNames).find(outer.focusOn); };
function landingStart() {
  if (outer.LAND.started) return;
  outer.LAND.started = true;
  if (!outer.landOn) return;
  let landed = false; try { landed = !!sessionStorage.getItem('p9-landed'); } catch {}
  if (landed || outer.settings.startLast) { outer.land.removeAttribute('data-pending'); outer.setFocus(lastFocus(), true); return; }
  // The intro (the mark and its orbit drawn in) belongs to the WebGL sky; with the video, P9 opens on the same page the mark
  // in the top bar opens (Builder, 2026-10-31: "the first one is wrong").
  openLanding(outer.LAND_BG === 'original');
}
function openLanding(intro) {
  outer.land.removeAttribute('data-pending');
  intro &&= !outer.still;
  outer.land.classList.remove('leaving');
  outer.land.dataset.stage = intro ? 'intro' : 'main';
  outer.land.toggleAttribute('data-run', intro);
  if (!outer.land.open) outer.land.showModal();
  outer.landVideo?.refresh();
  outer.land.focus();
  landGreeting(); landStatus(); landPets();
  outer.land.querySelectorAll('[data-land]').forEach(b => { b.hidden = !outer.focusOn(b.dataset.land); });
  outer.LAND.v = intro ? { uDist: 30, uShift: 0, uIgnite: 0, uStars: 0, uDim: 1 } : { ...outer.SKY_MAIN };
  if (intro) { tweenSky({ uDist: 22, uIgnite: 1, uStars: 1 }, 2400); outer.LAND.intro = outer.setTimeout(landMain, 2600); }
  if (!outer.sky.ok) return;
  if (outer.still) { outer.sky.size(1); outer.sky.set({ ...outer.LAND.v, uSpin: 4, uTime: 4 }); outer.sky.frame(); }
  else if (!outer.LAND.raf) { outer.LAND.drawn = 0; outer.LAND.raf = requestAnimationFrame(skyFrame); }
}
function landMain() {
  if (outer.land.dataset.stage === 'main') return;
  clearTimeout(outer.LAND.intro);
  outer.land.dataset.stage = 'main';
  tweenSky(outer.SKY_MAIN, 900);
}
const tweenSky = (to, ms) => { Object.assign(outer.LAND, { from: { ...outer.LAND.v }, to, t0: performance.now(), ms }); };
// The intro draws at 60 % of the window's pixels; behind the main stage, all of them at 30 frames a second (45 % looked
// soft on a 1x screen, Builder, 2026-10-19).
function skyFrame(now) {
  outer.LAND.raf = requestAnimationFrame(skyFrame);
  const main = outer.land.dataset.stage === 'main' && !outer.LAND.to;
  if (main && now - outer.LAND.drawn < 33) return;
  const dt = outer.LAND.drawn ? Math.min(0.1, (now - outer.LAND.drawn) / 1000) : 0; outer.LAND.drawn = now;
  if (outer.LAND.to) {
    const k = Math.min(1, (now - outer.LAND.t0) / outer.LAND.ms), e = 1 - (1 - k) ** 5;
    for (const key in outer.LAND.to) outer.LAND.v[key] = outer.LAND.from[key] + (outer.LAND.to[key] - outer.LAND.from[key]) * e;
    if (k === 1) outer.LAND.to = null;
  }
  outer.LAND.spin += dt * (outer.land.dataset.stage === 'main' ? 0.25 : 0.8);
  outer.sky.size(main ? 1 : 0.6);
  outer.sky.set({ ...outer.LAND.v, uSpin: outer.LAND.spin, uTime: now / 1000 });
  outer.sky.frame();
}
function leaveLanding() {
  if (!outer.land.open || outer.land.classList.contains('leaving')) return;
  outer.land.classList.add('leaving');
  outer.setTimeout(() => outer.land.close(), outer.still ? 0 : 420);
}
// Half the greetings know the time of day, half do not. The name goes in as text, never as markup.
const GREET = {
  morning: ['Good morning, {n}', 'Morning, {n}. Coffee first?', 'Rise and build, {n}'],
  afternoon: ['Good afternoon, {n}', 'Afternoon, {n}. Where were we?'],
  evening: ['Good evening, {n}', 'Evening, {n}. One more thing?'],
  night: ['Burning the midnight oil, {n}?', 'Still up, {n}?', 'Night shift, {n}?'],
  any: ['{n} returns!', 'Welcome back, {n}', 'What are we building, {n}?', 'The agents missed you, {n}', 'Gravity pulled you back, {n}'],
};
function landGreeting(now = new Date()) {
  const h = now.getHours(), name = outer.settings.name || '';
  let lines = Math.random() < 0.5 ? GREET[h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night'] : GREET.any;
  if (!name) lines = lines.filter(l => !l.startsWith('{n}')).map(l => l.replace(', {n}', ''));
  const [before, after = ''] = lines[Math.floor(Math.random() * lines.length)].split('{n}');
  const em = document.createElement('em'); em.textContent = name;
  outer.$('#landHi').replaceChildren(before, ...(name ? [em, after] : []));
}
// What is going on, refreshed each second while the landing shows.
function landStatus() {
  const running = outer.S.sessions.filter(s => s.state === 'running').length, need = outer.S.sessions.filter(s => s.pending).length + outer.S.reviews.filter(r => !outer.S.quiet.has(r.file)).length;
  const parts = [running && `${running} chat${running === 1 ? '' : 's'} running`, need && `${need} need${need === 1 ? 's' : ''} you`].filter(Boolean);
  outer.$('#landSub').textContent = parts.length ? parts.join(' · ') : 'All quiet. Where to?';
  outer.LAND.status = outer.setTimeout(() => { if (outer.land.open) landStatus(); }, 1000);
}
// Up to 12 installed pets, each on its own clock: idle, waving, jumping, thinking, waiting, running. A click makes one jump.
const LAND_ROWS = ['0', '0', '3', '4', '8', '6', '7'];
async function landPets() {
  const box = outer.$('#landPets'), list = window.p9?.listPets ? (await window.p9.listPets().catch(() => null))?.pets?.slice(0, 12) ?? [] : [];
  for (const p of list) if (!outer.IND.looks.has(p.name)) outer.IND.looks.set(p.name, await outer.petLook(p.name));
  if (!outer.land.open) return;
  box.innerHTML = list.filter(p => outer.IND.looks.get(p.name)).map(p => outer.petCanvas(p.name, '0', innerHeight < 700 ? 60 : 72, false)).join('');
  box.querySelectorAll('canvas.pet').forEach(cv => {
    const look = outer.IND.looks.get(cv.dataset.petName), rows = LAND_ROWS.filter(r => r === '0' || look.rows[r] > 1);
    cv.title = look.displayName; cv.dataset.phase = Math.floor(Math.random() * 8);
    const act = (row, ms) => { clearTimeout(cv.timer); cv.dataset.rows = row; cv.timer = outer.setTimeout(() => { if (cv.isConnected) act(rows[Math.floor(Math.random() * rows.length)], 1800 + Math.random() * 4200); }, ms); };
    act('0', 600 + Math.random() * 3000);
    cv.onclick = () => act(look.rows[4] > 1 ? '4' : '3', 1500);
  });
  outer.tickPets();
}
const FX_WHAT = { stopping: () => 'Pausing the chat here…', connecting: h => 'Connecting to ' + h + '…', uploading: h => 'Sending ' + (outer.fxFiles === outer.FX.id ? 'the files and the chat' : 'the chat') + ' to ' + h,
  landing: h => h + ' is setting it up…', syncing: () => 'Waiting for the files…' };
const mb = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
// From the press until it lands or fails (the plan alone can take half a minute): one notice says what is happening, and
// the button and the message box stay off, so a second press cannot start a second send (Builder's test, 2026-11-02).
async function leave(s) {
  if (s.leaving) return;
  const note = { t: 'notice', text: 'Moving this chat to ' + (outer.serverInfo?.last || 'the remote') + '. This takes about 30 seconds; don\'t type in this chat or close P9 until it finishes.' };
  s.leaving = true; s.events.push(note); outer.renderChats();
  try { await sendAway(s); } finally { s.leaving = false; s.events = s.events.filter(e => e !== note); outer.renderChats(); }
}
async function sendAway(s) {
  let files = [];
  if (window.p9.xferPlan) {
    const failed = () => ({ error: 'no-answer', message: 'P9 did not answer.' });
    let p = await window.p9.xferPlan(s.folder || '').catch(failed);
    // U4: a chat outside the workspace whose folder the remote does not have (or may not use): pick where it lands there.
    if (p.error === 'pick-folder') {
      const to = await outer.pickRemoteFolder({ ask: window.p9.xferFolders, title: 'Choose where the chat goes on the remote', note: p.message, verb: 'Lands in' });
      if (to === undefined) return; // Cancel: the chat stays here, nothing frozen, nothing sent
      p = await window.p9.xferPlan(s.folder, to).catch(failed);
    }
    if (p.error) { s.events.push({ t: 'notice', text: 'Not sent to the remote: ' + (p.message || p.error) }); return outer.renderChats(); }
    if (!p.syncthing.laptop.length && !p.syncthing.server.length) {
      const answer = !p.asked && !p.deletes ? [null, false] : await new Promise(done => {
        outer.xfer.id = p.id;
        outer.xferAsk(p, (choice, deleteToo) => { done([choice, deleteToo]); outer.$('#xferDlg').close(); }, true);
        outer.$('#xferDlg').addEventListener('close', () => done(null), { once: true });
      });
      outer.xfer.id = null;
      if (!answer) return; // Cancel: nothing frozen, nothing sent
      files = [p.id, ...answer];
    } else if (p.to !== undefined) files = [p.id, null, false]; // synced: the files wait for Syncthing; the plan carries where it lands
  }
  outer.fxFiles = files.length ? s.id : null;
  const r = await window.p9.sendToServer(s.id, ...files).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } }));
  if (r.body?.error === 'limit') return outer.xferRefused(r.body);
  // busy: main is moving it already (a window reloaded mid-move); its events draw it.
  if (r.status !== 200 && !['move-failed', 'busy'].includes(r.body?.error)) { s.events.push({ t: 'notice', text: 'Not sent to the remote: ' + (r.body?.message || r.body?.error || 'no answer') }); outer.renderChats(); }
}
function fxPlace() {
  const pane = [...document.querySelectorAll('.pane[data-id]')].find(p => p.dataset.id === outer.FX.id);
  if (!pane) return;
  // The pull scales and turns the pane about its centre: the centre stays, the size is its layout size (not the shrunk box).
  const home = pane.closest('dialog') || document.body, r = pane.getBoundingClientRect(), w = pane.offsetWidth, h = pane.offsetHeight;
  if (outer.fx.parentElement !== home) home.append(outer.fx);
  Object.assign(outer.fx.style, { left: r.left + r.width / 2 - w / 2 + 'px', top: r.top + r.height / 2 - h / 2 + 'px', width: w + 'px', height: h + 'px' });
}
function fxFrame(now) {
  outer.FX.raf = requestAnimationFrame(fxFrame);
  if (now - outer.FX.drawn < 33) return;
  const dt = outer.FX.drawn ? Math.min(0.1, (now - outer.FX.drawn) / 1000) : 0, k = Math.min(1, (now - outer.FX.t0) / 2400), e = 1 - (1 - k) ** 5;
  outer.FX.drawn = now;
  // The landing intro's ignition (30 -> 22), here driven by the move's percent: the hole draws closer as the chat goes in.
  outer.FX.dist += (30 - 8 * outer.FX.pct / 100 - outer.FX.dist) * Math.min(1, dt * 2);
  outer.FX.spin += dt * (0.8 + outer.FX.pct / 100);
  fxPlace();
  outer.fxSky.size(0.6);
  outer.fxSky.set({ uDist: outer.FX.dist, uShift: 0, uIgnite: e, uStars: e, uDim: 1 - 0.38 * e, uSpin: outer.FX.spin, uTime: now / 1000 });
  outer.fxSky.frame();
}
function fxStart(m) {
  Object.assign(outer.FX, { id: m.id, pull: m.id, host: m.host, t0: performance.now(), drawn: 0, spin: 0, dist: 30, pct: 0 });
  outer.renderChats();
  outer.fx.hidden = false; fxPlace();
  requestAnimationFrame(() => outer.fx.toggleAttribute('data-on', true));
  if (!outer.still && outer.fxSky.ok) outer.FX.raf = requestAnimationFrame(fxFrame);
  // Three missed heartbeats (5 s each): the move is not touched, the label says so.
  outer.FX.tick = setInterval(() => { fxPlace(); if (performance.now() - outer.FX.at > 15000 && !outer.fx.hasAttribute('data-wait')) { outer.fx.toggleAttribute('data-wait', true); outer.$('#moveWhat').textContent = 'Waiting for the remote…'; } }, 1000);
}
function fxEnd() {
  cancelAnimationFrame(outer.FX.raf); clearInterval(outer.FX.tick);
  outer.fx.hidden = true; outer.fx.removeAttribute('data-on'); outer.fx.removeAttribute('data-wait');
  Object.assign(outer.FX, { id: null, pull: null, raf: 0, tick: 0 });
  outer.renderChats();
}
function onMove(m) {
  if (!m?.id || (outer.FX.id && outer.FX.id !== m.id)) return;
  if (!outer.FX.id) fxStart(m);
  outer.FX.at = performance.now(); outer.fx.removeAttribute('data-wait');
  if (Number.isFinite(m.percent)) outer.FX.pct = m.percent;
  outer.$('#moveWhat').textContent = FX_WHAT[m.phase]?.(m.host) || 'Moving the chat to ' + m.host;
  outer.$('.move-bar').style.setProperty('--p', outer.FX.pct + '%'); outer.$('.move-bar').setAttribute('aria-valuenow', outer.FX.pct);
  outer.$('#movePct').textContent = outer.FX.pct + '%';
  outer.$('#moveBytes').textContent = m.bytes?.total ? ' · ' + mb(m.bytes.sent) + ' of ' + mb(m.bytes.total) : '';
  outer.$('#moveCancel').hidden = !['stopping', 'connecting', 'uploading'].includes(m.phase);
  if (m.phase === 'done') afterMove(m);
  // failed: the ledger's move-failed notice says why. unknown: the pane's "press to finish" button stays, with main's words.
  if (m.phase === 'failed') fxEnd();
  if (m.phase === 'unknown') { const s = outer.S.sessions.find(x => x.id === m.id); if (s && m.message) s.events.push({ t: 'notice', text: m.message }); fxEnd(); }
}
// "Open it on <host>?" and "Finish the move?": Enter takes the switch from anywhere in the box (a form's Enter would take
// its first button, Stay); Esc is no.
function moveAsk({ title, text, yes, no, never }) {
  outer.$('#moveT').textContent = title; outer.$('#moveP').textContent = text; outer.$('#moveYes').textContent = yes; outer.$('#moveNo').textContent = no;
  outer.$('#moveNeverRow').hidden = !never; outer.$('#moveNever').checked = false;
  outer.moveDlg.returnValue = '';
  outer.moveDlg.showModal();
  return new Promise(done => outer.moveDlg.addEventListener('close', () => done({ yes: outer.moveDlg.returnValue === 'yes', never: !!never && outer.$('#moveNever').checked }), { once: true }));
}
// Item 24. "Don't show again" keeps the answer it was ticked with: always open on the server, or always stay.
async function afterMove(m) {
  let kept = null; try { kept = localStorage.getItem('p9-after-move-ask'); } catch {}
  const pick = kept === 'open' || kept === 'stay' ? { yes: kept === 'open' } : await moveAsk({ title: 'Open it on ' + m.host + '?', yes: 'Open it', no: 'Stay here', never: true,
    text: 'The chat is on ' + m.host + ' now. Opening it switches this window to the remote; your chats on this computer stay here for when you switch back.' });
  if (pick.never) localStorage.setItem('p9-after-move-ask', pick.yes ? 'open' : 'stay');
  if (!pick.yes) return fxEnd();
  localStorage.setItem('p9-after-move', JSON.stringify({ id: m.id }));
  const r = await window.p9.server(m.host).catch(() => null); // main reloads the window onto the remote's P9
  if (!r?.ok) { localStorage.removeItem('p9-after-move'); fxEnd(); const s = outer.S.sessions.find(x => x.id === m.id); s?.events.push({ t: 'notice', text: 'Could not switch to ' + m.host + '. Settings > Remote Connect switches by hand.' }); outer.renderChats(); }
}
// After the first replay. The chat a move took here opens in the pane (on the server it is stopped, here it is moved).
// A chat left moving by a reload: no stream event within 6 s means main is not moving it, so ask to finish.
function moveReloaded() {
  let after = null; try { after = JSON.parse(localStorage.getItem('p9-after-move'))?.id; localStorage.removeItem('p9-after-move'); } catch {}
  const landed = after && outer.S.sessions.find(s => s.id === after && s.state !== 'moved');
  if (landed) outer.focus(landed.id);
  const left = outer.S.sessions.find(s => s.live && s.state === 'moving');
  if (!left || !window.p9?.sendToServer) return;
  outer.setTimeout(async () => {
    if (outer.FX.id || left.state !== 'moving' || outer.serverInfo?.host || outer.moveDlg.open) return;
    const r = await moveAsk({ title: 'Finish the move?', yes: 'Finish the move', no: 'Not now',
      text: '"' + (left.title || 'This chat') + '" was moving to ' + (outer.serverInfo?.last || 'the remote') + ' when the window closed. It stays paused here until the move finishes; its Send to remote button finishes it later.' });
    if (r.yes) leave(left);
  }, 6000);
}
// The title-bar badge, Remote · host or Local, opens the machine menu: This computer and the Settings > Remote list (D3),
// each with its state; a pick connects at once through the same IPC as Settings' Connect, and a remote without P9 lands on
// the connecting screen's Install (D15a). The remote in use says how its tunnel is; the others saved here or used last are
// probed over ssh as the menu opens (p9:remote-state, threat model row 50, c23 adds), Checking… until each answers.
// ~/.ssh/config hosts never saved or used are not asked.
const SERVER_STATE = { ok: ['ok', 'Connected'], 'server-no-p9': ['warn', 'P9 not running'], 'server-connecting': ['wait', 'Connecting…'], 'server-dropped': ['wait', 'Connecting…'] };
  return { NO_SKY, lastFocus, landingStart, openLanding, landMain, leaveLanding, leave, onMove, moveReloaded, SERVER_STATE };
}
