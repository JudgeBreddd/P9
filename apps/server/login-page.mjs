// The remote login page: request enrollment (the desktop approves it), register a passkey, or log in with one.
// Phase 11 builds the phone UI behind it; this page only gets a device a session.
export const loginPage = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>P9 login</title>'
  + '<style>body{font:16px system-ui;margin:0 auto;max-width:28rem;padding:1rem;background:#0b0d12;color:#e8eaf0}'
  + 'button,input{font:inherit;width:100%;padding:.75rem;margin:.25rem 0;border-radius:.5rem;border:1px solid #39404f;background:#161a22;color:inherit}'
  + 'button{background:#2f5bd3;border:0}#code{font-size:2rem;letter-spacing:.3rem;text-align:center}</style></head><body>'
  + '<h1>P9</h1><button id="login">Log in with passkey</button>'
  + '<h2>New device</h2><input id="name" placeholder="Device name" maxlength="40" autocomplete="off">'
  + '<button id="enroll">Ask the desktop to approve</button><p id="code"></p><p id="status" role="status"></p>'
  + '<script src="/login.js"></script></body></html>';

export const loginScript = String.raw`
const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const text = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const status = (message) => { document.getElementById('status').textContent = message; };
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function encode(credential) {
  const r = credential.response;
  const response = { clientDataJSON: text(r.clientDataJSON) };
  if (r.attestationObject) Object.assign(response, { attestationObject: text(r.attestationObject), transports: r.getTransports?.() ?? [] });
  else Object.assign(response, { authenticatorData: text(r.authenticatorData), signature: text(r.signature),
    userHandle: r.userHandle ? text(r.userHandle) : undefined });
  return { id: credential.id, rawId: text(credential.rawId), type: credential.type, response,
    clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment ?? undefined };
}
function done(result) {
  if (result.status >= 300) return status('Refused (' + (result.body.error ?? result.status) + ')');
  sessionStorage.setItem('p9-csrf', result.body.csrf);
  status('Logged in.');
  // A "Continue on phone" link that met sign-in keeps its chat; only an exact #chat=<uuid>, so the page bounces nowhere else.
  const chat = /^#chat=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(location.hash) ? location.hash : '';
  location.replace('/phone/' + chat);
}
document.getElementById('login').onclick = async () => {
  const start = await post('/auth/login/options');
  if (start.status !== 200) return status('Refused (' + (start.body.error ?? start.status) + ')');
  const options = start.body.options;
  const credential = await navigator.credentials.get({ publicKey: { ...options, challenge: bytes(options.challenge),
    allowCredentials: [] } }).catch(() => null);
  if (!credential) return status('Cancelled.');
  done(await post('/auth/login/verify', encode(credential)));
};
document.getElementById('enroll').onclick = async () => {
  const asked = await post('/auth/enroll', { name: document.getElementById('name').value.trim() });
  if (asked.status !== 201) return status('Refused (' + (asked.body.error ?? asked.status) + ')');
  document.getElementById('code').textContent = asked.body.code;
  status('Approve this code on the desktop, then come back here.');
  for (let i = 0; i < 300; i++) {
    const start = await post('/auth/enroll/' + asked.body.enrollment + '/options');
    if (start.status === 200) {
      const options = start.body.options;
      const credential = await navigator.credentials.create({ publicKey: { ...options, challenge: bytes(options.challenge),
        user: { ...options.user, id: bytes(options.user.id) }, excludeCredentials: [] } }).catch(() => null);
      if (!credential) return status('Cancelled. Ask the desktop again.');
      return done(await post('/auth/enroll/' + asked.body.enrollment + '/verify', encode(credential)));
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  status('Approval timed out.');
};
`;
