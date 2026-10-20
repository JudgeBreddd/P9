// Turns a raw recording (acp-record.mjs) into test/fixtures/acp/<provider>.json: drops _auth/* account notices,
// replaces the available-command list, replaces the scratch workspace with /workspace and the home directory with ~,
// redacts email addresses, and drops account metadata (_meta: rate limits and models, cost, usage) and plugin-provided
// agent options (values with a colon), which carry Builder's own plugins.
// Usage: node test/acp-sanitize.mjs <provider> <raw.jsonl> <scratch workspace dir>
//        node test/acp-sanitize.mjs <provider> --fixture   (re-scrub the committed fixture)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';

const [provider, raw, scratch] = process.argv.slice(2);
const pkg = provider === 'claude' ? 'claude-agent-acp' : 'codex-acp';
const target = new URL(`./fixtures/acp/${provider}.json`, import.meta.url);
const DROP = new Set(['_meta', 'cost', 'usage', 'model_usage']);
function scrub(value) {
  if (Array.isArray(value)) return value.filter((item) => !(typeof item?.value === 'string' && item.value.includes(':'))).map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !DROP.has(key)).map(([key, item]) => [key, scrub(item)]));
}
let fixture;
if (raw === '--fixture') {
  fixture = JSON.parse(readFileSync(target, 'utf8'));
} else {
  const version = JSON.parse(readFileSync(new URL(`../node_modules/@agentclientprotocol/${pkg}/package.json`, import.meta.url), 'utf8')).version;
  const clean = (text) => text.split(scratch).join('/workspace').split(os.homedir()).join('~')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'user@example.invalid');
  const lines = readFileSync(raw, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .map(({ dir, line }) => ({ dir, msg: JSON.parse(clean(line)) }))
    .filter(({ msg }) => !msg.method?.startsWith('_auth/'));
  // The command list carries the user's own skills; one placeholder keeps the message shape.
  for (const { msg } of lines) if (msg.params?.update?.sessionUpdate === 'available_commands_update') msg.params.update.availableCommands = [{ name: 'example', description: 'Placeholder for the recorded command list', input: null }];
  fixture = { provider, package: '@agentclientprotocol/' + pkg, version, lines };
}
fixture.lines = fixture.lines.map(({ dir, msg }) => ({ dir, msg: scrub(msg) }));
mkdirSync(new URL('./fixtures/acp/', import.meta.url), { recursive: true });
writeFileSync(target, JSON.stringify(fixture, null, 1) + '\n');
console.log(provider, fixture.version, fixture.lines.length, 'lines');
