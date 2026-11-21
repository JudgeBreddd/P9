// O205 Settings > Remote Connect > Devices: phone enrollments waiting for this window, and the devices signed in. The
// daemon serves /devices on its owner-only Unix socket only (main.mjs chatRoutes devices*); the phone has no such route.
import { esc } from './helpers.mjs';
let shown = '', note = '', seq = 0, timer;
const at = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const btn = (act, id, label, variant, name) => `<button data-slot="button" data-variant="${variant}" data-size="sm" data-device-${act}="${esc(id)}" data-name="${esc(name)}" aria-label="${label} ${esc(name)}">${label}</button>`;
const row = (name, sub, buttons) => `<li class="set-row"><span><strong>${esc(name)}</strong><span class="muted sm">${sub}</span></span><span class="spacer"></span>${buttons}</li>`;
const list = (title, rows) => rows.length ? `<p class="sm"><strong>${title}</strong></p><ul class="remote-list">${rows.join('')}</ul>` : '';
export async function drawDevices(box, host) {
  if (shown) box.innerHTML = shown; // the last list while the fresh one comes, so a redraw of Settings does not flash
  const mine = ++seq; clearTimeout(timer); box.dataset.draws = String(seq); // draws: the test counts them to see one loop
  const r = await window.p9.chat('devices', {}).catch(() => null);
  if (!box.isConnected || mine !== seq) return; // a newer draw (Refresh, a press, the timer) owns the box now
  const where = host ? 'P9 on ' + esc(host) : 'this P9';
  if (r?.status === 404) shown = `<p class="muted sm">Phone access is off on ${where}, so no phone can ask.</p>`;
  else if (r?.status !== 200) shown = `<p class="warn sm" role="alert">${where} did not answer, so the devices are not shown. Open Settings again in a moment.</p>`;
  else {
    const { devices = [], enrollments = [] } = r.body;
    const asks = enrollments.map(e => row(e.name, e.state === 'approved' ? `Approved: waiting for the phone to finish, until ${at(e.expires)}`
      : `Code ${esc(e.code)} · asks until ${at(e.expires)}. Approve only if the phone shows this code.`,
      (e.state === 'pending' ? btn('approve', e.id, 'Approve', 'default', e.name) : '') + btn('refuse', e.id, 'Refuse', 'outline', e.name)));
    const have = devices.filter(d => d.state !== 'revoked').map(d => row(d.name, (d.state === 'locked' ? 'Locked · ' : '') + 'Added ' + new Date(d.created).toLocaleDateString(),
      btn('remove', d.id, 'Remove', 'ghost', d.name)));
    shown = list('Waiting for approval', asks) + list('Signed in', have)
      + (asks.length || have.length ? '' : `<p class="muted sm">No phones yet. Open ${where}'s phone link on the phone; its request shows here.</p>`);
  }
  box.innerHTML = shown + `<div class="set-row"><span class="warn sm" role="alert">${esc(note)}</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" data-device-refresh>Refresh</button></div>`;
  note = '';
  const act = async (route, b) => {
    if (route === 'deviceRemove' && !confirm(`Remove ${b.dataset.name}? It is signed out at once and has to ask again to come back.`)) return;
    const done = await window.p9.chat(route, { id: b.dataset['device' + route.slice(6)] }).catch(() => null);
    if (done?.status !== 200) note = `Not done for ${b.dataset.name}: P9 did not take it (it may have lapsed or been answered already). The list below is fresh.`;
    drawDevices(box, host);
  };
  for (const route of ['deviceApprove', 'deviceRefuse', 'deviceRemove']) box.querySelectorAll(`[data-device-${route.slice(6).toLowerCase()}]`).forEach(b => { b.onclick = () => act(route, b); });
  box.querySelector('[data-device-refresh]').onclick = () => drawDevices(box, host);
  // A phone that asks while the page is open shows within 5 s. One loop: each draw cancels the last timer. It keeps ticking
  // while Settings holds this box and asks the daemon only while the list is on screen, so back on the page (or Settings
  // opened again on it) it refreshes within 5 s; a new Settings draw replaces the box and this loop ends.
  // ponytail: polling, not a pushed event; one small socket request every 5 s while visible.
  const tick = () => { if (!box.isConnected) return; if (box.offsetParent) drawDevices(box, host); else timer = setTimeout(tick, 5000); };
  timer = setTimeout(tick, 5000);
}
