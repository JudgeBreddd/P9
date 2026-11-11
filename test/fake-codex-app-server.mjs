// A stand-in for the bundled Codex's app server, for the live Codex usage read (main.mjs --codex-usage): started as
// `node <this file> cli app-server`. It answers the handshake and the one account call: 12% of the 5 h window and 88%
// of the week. FAKE_CODEX_USAGE=signed-out answers the call with an error; =hang never answers it.
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_CODEX_USAGE || '', now = Math.round(Date.now() / 1000);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
if (process.argv.slice(2).join(' ') !== 'cli app-server') process.exit(2);
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
  else if (message.method === 'account/rateLimits/read' && mode === 'signed-out') send({ id: message.id, error: { code: -32600, message: 'not signed in as someone@example.com' } });
  else if (message.method === 'account/rateLimits/read' && mode !== 'hang') send({ method: 'account/updated', params: {} }), send({ id: message.id, result: { accountId: 'acct', rateLimits: {
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now + 3600 }, secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: now + 2 * 86400 } } } });
});
