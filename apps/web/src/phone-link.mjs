import qrcode from 'qrcode-generator';
import { esc } from './helpers.mjs';

// PH1: "Continue on phone". The link opens the phone page on this chat (phone.ts reads #chat=<id>); the QR is drawn here
// from the link, so nothing leaves the window (no QR service). `origin` is this daemon's own --remote-origin
// (GET /setup/settings remoteOrigin), so the link names the machine the chat lives on.
export const phoneLink = (origin, chat) => `${origin}/phone#chat=${chat}`;

export function qrSvg(text) {
  const code = qrcode(0, 'M'); // type 0: the smallest version that fits
  code.addData(text);
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// The dialog's body. Remote logins off: say how to turn them on, with no link to copy.
export const phoneDialogBody = (origin, chat) => origin
  ? `<div class="qr" role="img" aria-label="QR code for the phone link">${qrSvg(phoneLink(origin, chat))}</div>
    <p><input data-slot="input" readonly data-phone-link aria-label="Phone link" value="${esc(phoneLink(origin, chat))}"></p>
    <p class="muted sm">Scan it, or copy the link to your phone. The phone signs in as usual, then opens this chat.</p>`
  : `<p>Remote logins are off on this computer. They are the phone's way in to P9 over Tailscale (for Continue on phone and the phone view).</p>
    <p class="muted sm">To turn them on, follow the Phone steps in the P9 README: add <code>--remote-port 8743 --remote-origin https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net</code> to the P9 service, restart it, then run <code>tailscale serve --bg 8743</code>.</p>`;
