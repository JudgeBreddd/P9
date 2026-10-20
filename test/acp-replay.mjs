// Replay agent, run as an --acp-override: answers P9's client with what the real adapter sent in a recorded session
// (test/fixtures/acp/<provider>.json). Each client message is matched to the next recorded one with the same method
// (or the next recorded reply), then the adapter's recorded lines up to the following client message are sent back,
// with reply ids rewritten to the live request ids. If P9's client sends a different sequence of methods, the replay
// stalls and the contract test fails. Parameters are not compared: changed arguments to the same method pass.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const fixture = JSON.parse(readFileSync(new URL(`./fixtures/acp/${process.argv[2]}.json`, import.meta.url), 'utf8'));
const lines = fixture.lines;
let next = 0;
const ids = new Map(); // recorded client request id -> live id
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', (text) => {
  const live = JSON.parse(text);
  const at = lines.findIndex((line, index) => index >= next && line.dir === 'in'
    && (live.method ? line.msg.method === live.method : !line.msg.method && line.msg.id === live.id));
  if (at === -1) { process.stderr.write('replay: no recorded match for ' + (live.method ?? 'reply ' + live.id) + '\n'); return; }
  if (live.method && 'id' in live) ids.set(lines[at].msg.id, live.id);
  next = at + 1;
  while (next < lines.length && lines[next].dir === 'out') {
    const message = structuredClone(lines[next].msg);
    if (!message.method && ids.has(message.id)) message.id = ids.get(message.id);
    send(message);
    next += 1;
  }
});
process.stdin.on('end', () => process.exit(0));
