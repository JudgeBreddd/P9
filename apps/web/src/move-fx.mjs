// The send-to-server move: its notice, the plan and pick steps, and the animation. Split out of controller.mjs's mountShell (F9);
// names that stay in mountShell come in through outer. The landing page that shared this file is gone (O122).

export function installMove(outer) {
const FX_WHAT = { stopping: () => 'Pausing the chat here…', connecting: h => 'Connecting to ' + h + '…', uploading: h => 'Sending ' + (outer.fxFiles === outer.FX.id ? 'the files and the chat' : 'the chat') + ' to ' + h,
  landing: h => h + ' is setting it up…', syncing: () => 'Waiting for the files…' };
const mb = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
// From the press until it lands or fails (the plan alone can take half a minute): one notice says what is happening, and
// the button and the message box stay off, so a second press cannot start a second send (seen in a hand test).
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
  return { leave, onMove, moveReloaded };
}
