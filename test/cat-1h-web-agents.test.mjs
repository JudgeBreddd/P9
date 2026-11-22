// CAT-1h: the rest of apps/web reads the agents GET /agents lists, so an agent added as catalog data only shows up in the
// sprint pickers, the loosened-mode warnings, Unrestricted mode's start modes and the onboarding card. Kestrel is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modes, LOOSE } from '../apps/web/src/helpers.mjs';
import * as security from '../apps/web/src/security.mjs';
import { rolesHtml } from '../apps/web/src/sprint-view.mjs';
import { onboardCard } from '../apps/web/src/onboarding.mjs';

const esc = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// As GET /agents lists them (apps/server/agents.mjs publicAgents), trimmed to what the web reads here.
const CLAUDE = { id: 'claude', name: 'Claude Code', short: 'Claude', modes: [{ name: 'Plan', tier: 0 }, { name: 'Manual', tier: 1 }, { name: 'Accept edits', tier: 2 }, { name: 'Auto', tier: 3 }, { name: 'Bypass permissions', tier: 4 }] };
const KESTREL = { id: 'kestrel', name: 'Kestrel Agent', short: 'Kestrel', modes: [{ name: 'Ask first', tier: 1 }, { name: 'Free run', tier: 4 }] };
const NO_LOOSE = { id: 'wren', name: 'Wren', short: 'Wren', modes: [{ name: 'Look only', tier: 0 }] };

test('CAT-1h: a catalog-only agent\'s loosest mode warns in the sprint role picker and is Unrestricted mode\'s start; the built-in ones stay', () => {
  globalThis.document ??= { addEventListener() {} }; // rolesHtml binds its Seen click once
  const bypass = LOOSE['Bypass permissions'];
  for (const a of [CLAUDE, KESTREL, NO_LOOSE]) modes[a.id] = a.modes.map((m) => m.name); // what the chat view's GET /agents read does (CAT-1f)
  security.fillLoose?.([CLAUDE, KESTREL, NO_LOOSE]);
  const o = { names: { claude: 'Claude', codex: 'Codex', kestrel: 'Kestrel', wren: 'Wren' }, profiles: [], lastModels: {}, lastPickers: {}, pickerKind: () => '' };
  const html = rolesHtml({ lead: 'L', prep: true, files: [] }, [{ key: 'w1', provider: 'kestrel', mode: 'Free run' }, { key: 'w2', provider: 'kestrel', mode: 'Ask first' }], o, esc);
  const pick = (role) => html.match(new RegExp(`<select[^>]*data-spr="mode" data-role="${role}"[^>]*>`))?.[0] ?? '';
  assert.match(html, /<option value="Free run" selected>Free run<\/option>/, 'its modes are listed');
  assert.match(pick('w1'), /title="Kestrel [^"]+"/, 'its loosest mode warns, naming the agent');
  assert.doesNotMatch(pick('w2'), /title=/, 'its asking mode does not warn');
  assert.equal(security.LOOSEST.kestrel, 'Free run', 'Unrestricted mode starts its new chats in its loosest mode');
  assert.equal(security.LOOSEST.wren, undefined, 'an agent with no loosened mode has none');
  assert.equal(security.LOOSEST.claude, 'Bypass permissions');
  assert.equal(security.LOOSEST.codex, 'Full access', 'an agent the answer leaves out keeps its own');
  assert.equal(LOOSE['Bypass permissions'], bypass, 'a built-in warning keeps its own words');
  assert.equal(LOOSE['Look only'], undefined);
  console.log('PASS CAT-1h loose: a catalog-only agent\'s loosest mode warns in the sprint picker and is Unrestricted mode\'s start');
});

test('CAT-1h: the onboarding card offers a build button for each agent it is given, and Claude and Codex when given none', () => {
  const html = onboardCard({ agents: [{ id: 'claude', name: 'Claude' }, { id: 'kestrel', name: 'Kestrel' }] }, esc);
  assert.match(html, /data-variant="default" data-build="claude">Have Claude build it</);
  assert.match(html, /data-variant="outline" data-build="kestrel">Have Kestrel build it</, 'a catalog-only agent gets its button');
  assert.doesNotMatch(html, /data-build="codex"/, 'an agent not given gets none');
  assert.match(onboardCard({}, esc), /data-build="claude">Have Claude build it<[\s\S]*data-build="codex">Have Codex build it</, 'the phone, which gives none, keeps both');
  assert.match(onboardCard({ agents: [{ id: 'k<x', name: '<b>' }] }, esc), /data-build="k&lt;x">Have &lt;b&gt; build it</, 'names are escaped');
  console.log('PASS CAT-1h onboarding: a build button per agent given');
});
