// The onboarding card on an empty Mission (M4, threat model row 72) and the space picker (row 71), drawn the same on the desktop
// and the phone. esc is the caller's escaper. Every word is P9's own; template names, titles and space names come from the daemon.
// protect: File protection is on, so an agent cannot write the space yet: say so, with a button to that setting.
export function onboardCard({ templates = [], spaces = [], current = null, protect = false }, esc) {
  return '<section class="onboard" data-onboard aria-labelledby="onboardTitle">'
    + '<h3 id="onboardTitle">Build your Mission Control</h3>'
    + '<p>Mission Control is your control room: buttons that run your scripts, live numbers, log views, notes and links, in sections you choose. It is empty for now.</p>'
    + '<p class="muted">Have an agent build it with you, or start from a template and fill it in. You can change all of it later.</p>'
    + '<div class="onboard-go">'
    + '<button type="button" data-slot="button" data-variant="default" data-build="claude">Have Claude build it</button>'
    + '<button type="button" data-slot="button" data-variant="outline" data-build="codex">Have Codex build it</button>'
    + '<button type="button" data-slot="button" data-variant="outline" data-yourself>Build it yourself</button></div>'
    + (protect ? '<div class="onboard-protect" data-onboard-protect><p>' + PROTECT_WORDS[0] + '</p>'
      + '<button type="button" data-slot="button" data-variant="outline" data-size="sm" data-open-protect>Open File protection</button>'
      + '<p class="muted">' + PROTECT_WORDS[1] + '</p></div>' : '')
    + (templates.length ? '<h4>Or start from a template</h4><div class="onboard-tpls">' + templates.map((t) => `<button type="button" class="onboard-tpl" data-template="${esc(t.name)}">`
      + `<b>${esc(t.title)}</b><span>${esc(t.about)}</span></button>`).join('') + '</div>' : '')
    + spacePicker(spaces, current, esc)
    + '<p class="muted" data-onboard-note role="status"></p></section>';
}
// The same two lines are in the shipped guide (templates/guide.mjs).
export const PROTECT_WORDS = ['File protection is on. Claude or Codex can write your space only while it is off.',
  'Turn File protection back on once the build is done.'];
// Main and each scratch space there is; shown only once a scratch space exists.
export const spacePicker = (spaces, current, esc) => (spaces.length || current
  ? '<label class="space-pick" data-space-picker><span>Space</span><select data-slot="select" data-space-pick aria-label="Space Mission shows">'
    + `<option value=""${current ? '' : ' selected'}>Main</option>` + spaces.map((name) => `<option value="${esc(name)}"${name === current ? ' selected' : ''}>${esc(name)}</option>`).join('')
    + '</select></label>'
  : '');
// What a template click answered, in words.
export const templateWords = (status, body) => (status === 201 ? 'Template added. Rename and fill its sections.'
  : body?.error === 'space-not-empty' ? 'Your space has sections already, so P9 adds no template to it.'
    : 'Template not added (' + (body?.error || status) + ').');
