// W2: the shipped Mission guide tells the agent how to add panels, reuse registry buttons, make a card, and what to do when stuck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE } from '../apps/server/templates/guide.mjs';
import { CARD, SECTION, describeMission } from '../apps/server/mission-fields.mjs';

test('Mission guide: built-in panels, registry refs, the card file step, and ask instead of skip', { timeout: 5000 }, () => {
  assert.match(GUIDE, /built-in panels or tiles, give add_section's set a widget: waiting \(Waiting on you\), usage \(Usage\), apps \(Apps and pages\), notifications \(Notifications\)[^.]*\. For a section already there, call update_section with widget/);
  assert.match(GUIDE, /folders, links and checklists with set_section_items/);
  assert.match(GUIDE, /call update_section with refs and the button's ID\. Never copy its command/);
  assert.match(GUIDE, /write a workspace \.html file with its own file tool \(you approve the write\)\. Then add it with set_section_items cards\. The \.html file stays in the workspace even if a scratch space is dropped/);
  assert.match(GUIDE, /cannot find a folder, file or command, ask you in the chat\. Never skip it/);
  assert.match(GUIDE, /At the end, list anything it did not build/);
  assert.match(CARD.html.doc, /its own file tool, which the user approves; Mission tools never write it/);
  assert.match(SECTION.cards.doc, /Write the \.html file first, then add the card here/);
});

// MC-6, MC-7, MC-8, MC-9, MC-10, MC-11: what an agent building a space is told, in the guide (a build chat's first message) and in describe_mission.
test('MC-6..MC-11: the guide and describe_mission say one write per section, columns not tiles, ssh, slow scripts, refresh and the terminal', { timeout: 5000 }, () => {
  const { about } = describeMission();
  for (const text of [GUIDE, about]) {
    assert.match(text, /a space of tiles leaves the page (body )?empty/, 'MC-11');
    assert.match(text, /col1 to col6/, 'MC-11');
    assert.match(text, /ssh/, 'MC-7');
    assert.match(text, /timer or cron job write/, 'MC-8');
    assert.match(text, /konsole on Linux and (in )?a console window on Windows/, 'MC-10');
  }
  assert.match(GUIDE, /Add each section with add_section, in one write: its set takes the section's other fields \(icon, widget, buttons, data, cards/, 'MC-6');
  assert.match(GUIDE, /give add_section's set a widget/, 'MC-9');
  assert.match(GUIDE, /refresh \(30 to 3600 seconds\)/, 'MC-20');
  assert.match(about, /refresh \(seconds\) on its section runs it less often/, 'MC-8');
  assert.equal(SECTION.refresh.check(29), false); assert.equal(SECTION.refresh.check(3601), false); assert.equal(SECTION.refresh.check(30.5), false); assert.equal(SECTION.refresh.check(300), true);
});
