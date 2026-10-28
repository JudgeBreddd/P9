import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { remoteDaemon, root } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
// A screenshot goes out in the log (P9_SHOT name base64), as agent-setup.test.mjs does.
const shot = async (page, name) => { await page.waitForTimeout(300); const png = await page.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };

// P9 + K13 (threat model row 31): the phone signs in to both agents with the wizard's own login. The daemon hands over only
// a vendor's sign-in page, opened by a tap; a Claude code typed while offline stays in the box; a CSRF-less POST is refused.
test('P9: the phone signs in to Claude and Codex; only a vendor page and a code-shaped code reach it; a typed code is never lost', { timeout: 120000 }, async (t) => {
  const deadline = Date.now() + 110000, left = () => Math.max(1000, deadline - Date.now());
  const server = await remoteDaemon(t, { args: ['--acp-override', fake] });
  const at = (name) => path.join(server.workspace, name);
  const { page } = await phone(t, server);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('nav [data-nav="usage"]').click();
  const card = (agent) => page.locator(`#signIn [data-agent="${agent}"]`);
  await card('claude').getByText('Not signed in').waitFor({ timeout: left() });
  // P8: Codex is not signed in here, so its plan line says so (not an old figure).
  await page.locator('[data-limits]').getByText('Codex not logged in').waitFor({ timeout: left() });
  await shot(page, 'p8-phone-codex-not-logged-in');
  assert.equal(await page.evaluate(async () => (await fetch('/phone/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"agent":"claude"}' })).status), 403, 'no CSRF token, no sign-in');

  // Claude: a tap-to-open link to the vendor page, and the code box.
  await card('claude').locator('[data-sign="start:claude"]').click();
  const link = card('claude').locator('a[data-sign-link]');
  await link.waitFor({ timeout: left() });
  assert.deepEqual(await link.evaluate((a) => [a.href, a.textContent, a.target, a.rel]), ['https://claude.com/cai/oauth/authorize?fake=1', "Open Claude's sign-in page", '_blank', 'noopener noreferrer']);
  const box = card('claude').locator('[data-sign-code]');
  await box.fill('abc#123 $(id)');
  await page.context().setOffline(true);
  await card('claude').getByRole('button', { name: 'Send code' }).click();
  await card('claude').getByText(/You are offline\. Nothing was sent|The daemon did not answer\. Try again\./).waitFor({ timeout: left() });
  assert.equal(await box.inputValue(), 'abc#123 $(id)', 'the typed code stays');
  await shot(page, 'p9-phone-claude-offline');
  await page.context().setOffline(false);
  await page.waitForTimeout(2500); // a poll redraws the card meanwhile: the typed code survives it
  assert.equal(await box.inputValue(), 'abc#123 $(id)');
  await card('claude').getByRole('button', { name: 'Send code' }).click();
  const sent = async () => { for (;;) { const text = await readFile(at('fake-login-code'), 'utf8').catch(() => ''); if (text || Date.now() > deadline) return text; await page.waitForTimeout(200); } };
  assert.equal(await sent(), '"abc#123 $(id)"\n', 'the code went to the CLI as typed');
  assert.equal(await box.inputValue(), '');
  // Claude takes the code and exits signed in.
  await mkdir(path.join(server.directory, '.claude'), { recursive: true });
  await writeFile(path.join(server.directory, '.claude', '.credentials.json'), '{}');
  await box.fill('done');
  await card('claude').getByRole('button', { name: 'Send code' }).click();
  await card('claude').getByText('Signed in').waitFor({ timeout: left() });
  await card('claude').getByRole('button', { name: 'Sign in again' }).waitFor({ timeout: left() });

  // Codex: OpenAI's page and its one-time code.
  await card('codex').locator('[data-sign="start:codex"]').click();
  const code = card('codex').locator('.sign-code code');
  await code.waitFor({ timeout: left() });
  assert.equal(await code.innerText(), 'ABCD-12345');
  assert.equal(await card('codex').locator('a[data-sign-link]').evaluate((a) => a.href), 'https://auth.openai.com/codex/device');
  await shot(page, 'p9-phone-codex-code');
  await card('codex').getByRole('button', { name: 'Cancel' }).click();
  await card('codex').locator('[data-sign="start:codex"]').waitFor({ timeout: left() });

  // A page that only looks like OpenAI's, and output that is not a code, never reach the phone.
  await writeFile(at('fake-login-url'), 'https://auth.openai.com.evil.example/codex/device');
  await writeFile(at('fake-login-device'), '<b>x</b>');
  await card('codex').locator('[data-sign="start:codex"]').click();
  await card('codex').getByText('Starting sign-in…').waitFor({ timeout: left() });
  await page.waitForTimeout(2500);
  const state = await page.evaluate(async () => (await fetch('/phone/sign-in')).json());
  assert.deepEqual(state.codex, { signedIn: false, running: true, url: null, code: null, unsupported: false, exit: null });
  assert.equal(await card('codex').locator('a').count(), 0);
  await card('codex').getByRole('button', { name: 'Cancel' }).click();

  // A codex without the device sign-in is named.
  await rm(at('fake-login-url'));
  await writeFile(at('fake-login-device'), 'unsupported');
  await card('codex').locator('[data-sign="start:codex"]').click();
  await card('codex').getByText('This Codex has no sign-in with a code').waitFor({ timeout: left() });
  await shot(page, 'p9-phone-codex-unsupported');
  assert.deepEqual(errors, []);
  console.log('PASS P9: phone sign-in for both agents');
});
