import { esc, info } from './helpers.mjs';

// MT1: Settings → Maintenance, for when P9 misbehaves. Each button also has a Ctrl K entry (controller.mjs cmds); `when`
// says whether this window offers it (the desktop's window.p9; Rebuild only in a source checkout).
export const MAINTENANCE = [
  { id: 'mtReload', label: 'Reload window', tip: 'Loads this window again. Chats keep running; text you have not sent is lost.', when: () => true },
  { id: 'mtMission', label: 'Refresh Mission', tip: "Reads Mission Control's settings, buttons and space again now.", when: () => !!window.p9?.mission },
  { id: 'mtRestart', label: 'Restart daemon', tip: "Restarts P9's background service and waits until the new one answers. Running chats, scripts and terminals stop.", when: () => !!window.p9?.restartService },
  { id: 'mtRepair', label: 'Repair daemon service', tip: 'Sets the background service up again and starts it, for a service that is missing or out of date. Running chats, scripts and terminals stop.', when: () => !!window.p9?.repairService },
  { id: 'mtRebuild', label: 'Rebuild + reload', tip: 'Source checkouts only: runs pnpm build, then reloads this window with the new build.', when: () => !!window.p9?.source },
];

// The Updates row (A ↔ B1 contract, window.p9.updates): what the updater says, and the one button that fits its state.
const UPDATE_TEXT = {
  off: u => 'Automatic updates are off' + (u.reason ? ': ' + u.reason : '') + '.',
  idle: u => u.available ? 'P9 ' + u.available + ' is out.' : 'You have the newest P9.',
  checking: () => 'Checking for a newer P9…',
  downloading: u => 'Downloading P9 ' + (u.available || '') + '…',
  ready: u => 'P9 ' + (u.available || '') + ' is downloaded. Restart P9 to update.',
  error: u => 'The last check failed' + (u.reason ? ': ' + u.reason : '') + '.',
};
const updatesRow = u => `<div class="set-row"><span><strong>Updates</strong><span class="muted sm" id="mtUpdText">You have P9 ${esc(u.current || window.p9.version || '?')}. ${esc((UPDATE_TEXT[u.state] || UPDATE_TEXT.error)(u))}</span></span><span class="spacer"></span>`
  + (u.state === 'ready' ? '<button data-slot="button" data-variant="default" id="mtUpdInstall">Restart to update</button>'
    : `<button data-slot="button" data-variant="outline" id="mtUpdCheck" ${['off', 'checking', 'downloading'].includes(u.state) ? 'disabled' : ''}>Check now</button>`)
  + info('Checks GitHub for a newer P9 and installs it when you restart. Your workspace and settings stay.', 'updates') + '</div>';

// updates: the last answer from window.p9.updates(), or null when this build has no updater.
export const maintenanceGroup = updates => `<fieldset class="set-group"><legend>Maintenance ${info('Fixes for when P9 misbehaves. Each is also in Ctrl K.', 'maintenance')}</legend>`
  + (updates ? updatesRow(updates) : '')
  + MAINTENANCE.filter(m => m.when()).map(m => `<div class="set-row"><button data-slot="button" data-variant="outline" id="${m.id}">${m.label}</button><span class="spacer"></span>${info(m.tip, 'maintenance')}</div>`).join('')
  + '</fieldset>';
