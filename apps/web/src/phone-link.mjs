import qrcode from 'qrcode-generator';
import { esc } from './helpers.mjs';

// PH1: "Continue on phone". The link opens the phone page on this chat (phone.ts reads #chat=<id>); the QR is drawn here
// from the link, so nothing leaves the window (no QR service). `host` is the settings.json server_host.
export const phoneLink = (host, chat) => `https://${host}/phone#chat=${chat}`;

export function qrSvg(text) {
  const code = qrcode(0, 'M'); // type 0: the smallest version that fits
  code.addData(text);
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// The dialog's body. No host set: say where to set it, with no link to copy.
export const phoneDialogBody = (host, chat) => host
  ? `<div class="qr" role="img" aria-label="QR code for the phone link">${qrSvg(phoneLink(host, chat))}</div>
    <p><input data-slot="input" readonly data-phone-link aria-label="Phone link" value="${esc(phoneLink(host, chat))}"></p>
    <p class="muted sm">Scan it, or copy the link to your phone. The phone signs in as usual, then opens this chat.</p>`
  : '<p>Set <strong>Server host name</strong> in Settings → Mission Control files first. It is the name your phone reaches this computer by.</p>';
