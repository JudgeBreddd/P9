// Recording shim, run as an --acp-override: starts the real pinned adapter and copies every JSON-RPC line both ways
// to <tmp>/p9-acp-record-<provider>.jsonl. A separate sanitize step turns that file into test/fixtures/acp/<provider>.json.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const provider = process.argv[2];
const entry = fileURLToPath(new URL(`../node_modules/@agentclientprotocol/${provider === 'claude' ? 'claude-agent-acp' : 'codex-acp'}/dist/index.js`, import.meta.url));
const log = createWriteStream(path.join(os.tmpdir(), `p9-acp-record-${provider}.jsonl`), { flags: 'a', mode: 0o600 });
const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
const tee = (input, output, dir) => createInterface({ input }).on('line', (line) => {
  log.write(JSON.stringify({ dir, at: Date.now(), line }) + '\n');
  output.write(line + '\n');
});
tee(process.stdin, child.stdin, 'in');
tee(child.stdout, process.stdout, 'out');
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (code) => log.end(() => process.exit(code ?? 1)));
