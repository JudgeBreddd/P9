// The paperclip, paste, drop and the phone's + (P8, A2 step 1): what a person attaches, read and checked before sending.
// Out of helpers.mjs so the desktop shell loads it on the first attach or send, not at startup (shell-bundle budget).
import { IMG_OK } from './helpers.mjs';
// An image a person attaches (threat model row 20; the daemon checks the same limits): desktop paperclip, paste and drop,
// and the phone's + (P8). Over 1568 px or near 2 MB it is scaled to a JPEG; still over 2 MB, refused with the reason.
export const MAX_IMAGES = 4, MAX_IMAGE = 2 * 1024 * 1024;
const base64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
export async function readImage(file) {
  if (!IMG_OK.includes(file.type)) throw new Error('PNG, JPEG, GIF or WebP only');
  let blob = file, mimeType = file.type;
  const bmp = await createImageBitmap(file), k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  if (k < 1 || file.size > MAX_IMAGE * 3 / 4) {
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }); mimeType = 'image/jpeg';
  }
  const data = await base64(blob);
  if (data.length > MAX_IMAGE) throw new Error('still over 2 MB after scaling');
  return { mimeType, data, name: file.name };
}
// A2 step 1: any other file goes as a file (SECURITY.md § Files you send in a chat; the daemon checks the same limits). It is
// saved in that chat's own folder, where its agent can open, edit and save it. Four photos and four files a message, a file
// up to 6 MiB (8 MiB as sent), and the whole message under the 12 MiB body limit. Attached items carry file: true.
export const MAX_FILES = 4, MAX_FILE = 8 * 1024 * 1024, MAX_SENT = 12 * 1024 * 1024 - 64 * 1024;
export const attachFull = (file, list) => { const photo = IMG_OK.includes(file.type); return list.filter(a => !a.file === photo).length >= (photo ? MAX_IMAGES : MAX_FILES) ? `Four ${photo ? 'images' : 'files'} a message at most` : ''; };
// The daemon's file-name rule (apps/server/chat.mjs fileName and DEVICE; keep the two alike), so a name it would refuse is refused when
// attached, with the reason, not after the send.
const NAME_BAD = /[\x00-\x1f/\\:*?"<>|]|[. ]$|^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$) *(\.|$)/i;
export const tooBig = (got, list) => list.reduce((n, a) => n + a.data.length, got.data.length) > MAX_SENT ? 'with the others it would be over 12 MiB, the most one message can carry' : '';
export async function readAttachment(file, list) {
  if (!IMG_OK.includes(file.type) && (NAME_BAD.test(file.name) || new TextEncoder().encode(file.name).length > 200)) throw new Error('its name cannot have / \\ : * ? " < > |, end in a dot or space, be over 200 bytes or be a Windows device name such as CON; rename it and attach it again');
  if (!IMG_OK.includes(file.type) && file.size > MAX_FILE * 3 / 4) throw new Error('over 6 MiB, the most a file can be');
  const got = IMG_OK.includes(file.type) ? await readImage(file) : { file: true, name: file.name, data: await base64(file), ...(file.type && { mimeType: file.type }) };
  const big = tooBig(got, list); if (big) throw new Error(big);
  return got;
}
// What POST /chat/:id/prompt takes: photos as images, the rest as files.
export const attachBody = list => {
  const images = list.filter(a => !a.file).map(({ mimeType, data }) => ({ mimeType, data })), files = list.filter(a => a.file).map(({ name, data, mimeType }) => ({ name, data, ...(mimeType && { mimeType }) }));
  return { ...(images.length && { images }), ...(files.length && { files }) };
};
