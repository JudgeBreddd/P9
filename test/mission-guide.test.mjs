// W2: the shipped Mission guide tells the agent how to add panels, reuse registry buttons, make a card, and what to do when stuck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE } from '../apps/server/templates/guide.mjs';
import { CARD, SECTION } from '../apps/server/mission-fields.mjs';

test('Mission guide: built-in panels, registry refs, the card file step, and ask instead of skip', { timeout: 5000 }, () => {
  assert.match(GUIDE, /Waiting on you, Usage, Apps and pages or Notifications\), call update_section with widget/);
  assert.match(GUIDE, /folders, links and checklists with set_section_items/);
  assert.match(GUIDE, /call update_section with refs and the button's ID\. Never copy its command/);
  assert.match(GUIDE, /write a workspace \.html file with its own file tool \(you approve the write\)\. Then add it with set_section_items cards\. The \.html file stays in the workspace even if a scratch space is dropped/);
  assert.match(GUIDE, /cannot find a folder, file or command, ask you in the chat\. Never skip it/);
  assert.match(GUIDE, /At the end, list anything it did not build/);
  assert.match(CARD.html.doc, /its own file tool, which the user approves; Mission tools never write it/);
  assert.match(SECTION.cards.doc, /Write the \.html file first, then add the card here/);
});
