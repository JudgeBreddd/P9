// O17: the Event Horizon Azure theme (p9-event-horizon-azure). Its colours are the contract from the theme's spec
// (Builder, 2026-11-07: "The HEX values and mappings in this file are the implementation contract"). This file checks
// the shipped files against that contract; dev.test.mjs "Event Horizon Azure" checks the real rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './helpers.mjs';

const ID = 'p9-event-horizon-azure';
const read = file => readFile(path.join(root, file), 'utf8');

// Spec § 6, every property, as written there.
const PALETTE = {
  'bg-app': '#080B13', 'bg-editor': '#0B101B', 'bg-panel': '#101727', 'bg-elevated': '#172037', 'bg-code-block': '#17172C', 'bg-line-hover': '#141D2E',
  'border-subtle': '#283348', 'border-active-violet': '#8A63D6', 'border-active-azure': '#399BD8',
  'text-primary': '#DCE5F1', 'text-secondary': '#A4B1C6', 'text-muted': '#75839A', 'text-on-accent': '#080B13',
  'syntax-violet': '#B77AFF', 'syntax-violet-dim': '#8A63D6', 'syntax-azure': '#42C7F5', 'syntax-azure-dim': '#399BD8', 'syntax-blue': '#7EA9F8',
  'syntax-amber': '#F6BB58', 'syntax-mint': '#63D9BD', 'syntax-red': '#F17F94', 'syntax-gold-muted': '#D7AF77',
  'selection': '#56478C70', 'selection-inactive': '#3A456354', 'search-match': '#F6BB5840', 'search-current': '#F6BB5870', 'focus-ring': '#7EA9F8',
  'diagnostic-error': '#F17F94', 'diagnostic-warning': '#F6BB58', 'diagnostic-info': '#42C7F5', 'diagnostic-success': '#63D9BD',
  'diff-added-bg': '#163B33', 'diff-removed-bg': '#3A1F2A',
};
const P = PALETTE;
// Spec §§ 2 and 5: editor chrome.
const CHROME = {
  'editor.background': P['bg-editor'], 'editor.foreground': P['text-primary'], 'activityBar.background': P['bg-app'], 'sideBar.background': P['bg-panel'],
  'panel.background': P['bg-panel'], 'editorWidget.background': P['bg-elevated'], 'editorSuggestWidget.background': P['bg-elevated'],
  'editorSuggestWidget.border': P['border-subtle'], 'editorSuggestWidget.selectedBackground': P['bg-line-hover'], 'editorSuggestWidget.highlightForeground': P['syntax-azure'],
  'editorLineNumber.foreground': P['text-muted'], 'editorLineNumber.activeForeground': P['text-secondary'], 'editorCursor.foreground': P['syntax-azure'],
  'editor.selectionBackground': P.selection, 'editor.inactiveSelectionBackground': P['selection-inactive'],
  'editor.findMatchBackground': P['search-current'], 'editor.findMatchHighlightBackground': P['search-match'], 'focusBorder': P['focus-ring'],
  'editor.lineHighlightBackground': P['bg-line-hover'], 'editorBracketMatch.border': P['syntax-blue'], 'editorBracketMatch.background': '#00000000',
  // § 4: brackets are punctuation (text.secondary). The editor's own bracket-pair colours would otherwise paint them, and the
  // ">" of "=>", in colours off the palette, in opened files only (not in a Markdown fence).
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`editorBracketHighlight.foreground${n}`, P['text-secondary']])), 'editorBracketHighlight.unexpectedBracket.foreground': P['text-secondary'],
  'editorGutter.foldingControlForeground': P['text-muted'], 'editorError.foreground': P['diagnostic-error'], 'editorWarning.foreground': P['diagnostic-warning'],
  'editorInfo.foreground': P['diagnostic-info'], 'diffEditor.insertedLineBackground': P['diff-added-bg'], 'diffEditor.removedLineBackground': P['diff-removed-bg'],
  'tab.activeBorderTop': P['border-active-azure'], 'editorGroup.border': P['border-subtle'],
};
// Spec § 4 (code) and § 3 (Markdown source): a scope the grammars emit -> the colour, and the font style where the spec names one.
const SCOPES = [
  ['keyword.control.import.ts', P['syntax-violet']], ['storage.type.interface.ts', P['syntax-violet']], ['storage.modifier.async.ts', P['syntax-violet']],
  ['keyword.operator.new.ts', P['syntax-violet']], ['keyword.control.flow.ts', P['syntax-violet']], ['keyword.operator.logical.python', P['syntax-violet']],
  ['entity.name.function.ts', P['syntax-azure']], ['support.function.builtin.python', P['syntax-azure']],
  ['entity.name.type.class.ts', P['syntax-blue']], ['entity.name.type.interface.ts', P['syntax-blue']], ['support.type.primitive.ts', P['syntax-blue']],
  ['meta.decorator.ts', P['syntax-blue']], ['punctuation.decorator.ts', P['syntax-blue']], ['punctuation.definition.decorator.python', P['syntax-blue']],
  ['string.quoted.single.ts', P['syntax-amber']], ['punctuation.definition.string.begin.ts', P['syntax-amber']], ['constant.numeric.decimal.ts', P['syntax-amber']],
  ['constant.language.boolean.true.ts', P['syntax-mint']], ['constant.language.null.ts', P['syntax-mint']], ['constant.language.python', P['syntax-mint']],
  ['string.regexp.ts', P['syntax-gold-muted']],
  ['variable.other.readwrite.ts', P['text-primary']], ['variable.parameter.ts', P['text-primary']], ['variable.other.property.ts', P['text-primary']], ['meta.object-literal.key.ts', P['text-primary']],
  ['keyword.operator.assignment.ts', P['text-secondary']], ['storage.type.function.arrow.ts', P['text-secondary']], ['punctuation.terminator.statement.ts', P['text-secondary']], ['meta.brace.round.ts', P['text-secondary']],
  ['comment.line.double-slash.ts', P['text-muted']], ['punctuation.definition.comment.ts', P['text-muted']], ['invalid.illegal.ts', P['diagnostic-error']],
  ['support.type.property-name.json', P['syntax-azure']], ['support.type.property-name.css', P['syntax-azure']], ['entity.other.attribute-name.class.css', P['syntax-violet']],
  ['support.constant.property-value.css', P['syntax-amber']], ['variable.css', P['syntax-blue']], ['entity.name.command.shell', P['syntax-azure']], ['constant.other.option', P['syntax-blue']],
  ['punctuation.definition.heading.markdown', P['syntax-violet'], ''], ['entity.name.section.markdown', P['syntax-violet'], 'bold'], ['markup.heading.markdown', P['syntax-violet'], 'bold'],
  ['markup.bold.markdown', P['text-primary'], 'bold'], ['markup.italic.markdown', P['text-primary'], 'italic'], ['markup.strikethrough.markdown', P['text-secondary'], 'strikethrough'],
  ['punctuation.definition.list.begin.markdown', P['syntax-violet-dim']], ['punctuation.definition.quote.begin.markdown', P['syntax-violet-dim']], ['markup.quote.markdown', P['text-secondary']],
  ['string.other.link.title.markdown', P['syntax-azure']], ['markup.underline.link.markdown', P['syntax-blue']], ['markup.inline.raw.string.markdown', P['syntax-amber']],
  ['punctuation.definition.markdown', P['syntax-violet-dim']], ['fenced_code.block.language.markdown', P['syntax-blue']],
  ['punctuation.separator.table.markdown', P['text-muted']], ['meta.separator.markdown', P['syntax-violet-dim']], ['constant.character.escape.markdown', P['text-secondary']],
];
// TextMate's choice for a lone scope: the longest selector that equals it or is a dot-prefix of it; later rules win ties.
function resolve(rules, scope) {
  let best = null, length = -1;
  for (const rule of rules) for (const selector of [rule.scope].flat()) {
    if (selector.includes(' ')) continue;
    if ((scope === selector || scope.startsWith(selector + '.')) && selector.length >= length) { best = rule.settings; length = selector.length; }
  }
  return best;
}

test('Event Horizon Azure: the shipped editor theme, shell CSS and picker entry match the spec contract', async () => {
  const theme = JSON.parse(await read('apps/dev/public/event-horizon-azure-theme.json')), css = await read('apps/web/src/lib/event-horizon-azure.css');
  // § 6: every --p9-* property in the shell CSS, with its value.
  const block = css.slice(css.indexOf(`[data-theme="${ID}"] {`), css.indexOf('}'));
  const props = Object.fromEntries([...block.matchAll(/--p9-([a-z-]+):\s*(#[0-9A-Fa-f]{6,8});/g)].map(([, name, value]) => [name, value.toUpperCase()]));
  assert.deepEqual(props, PALETTE, 'the § 6 properties');
  // The DUWOP tokens come from the palette, not their own hex values.
  assert.doesNotMatch(css.slice(css.indexOf('.dark[data-theme')), /:\s*#[0-9A-Fa-f]{3,8}\s*;/, 'DUWOP tokens are set from --p9-* only');
  assert.match(css, /--background:\s*var\(--p9-bg-app\)/); assert.match(css, /--foreground:\s*var\(--p9-text-primary\)/); assert.match(css, /--primary:\s*var\(--p9-syntax-violet\)/);
  assert.doesNotMatch(css, /text-shadow|box-shadow|animation|gradient/, 'no glow, shadow, animation or gradient (§ 8)');
  // §§ 2 and 5: editor chrome.
  assert.equal(theme.type, 'dark'); assert.equal(theme.semanticHighlighting, true);
  const chrome = Object.fromEntries(Object.keys(CHROME).map(key => [key, theme.colors[key]?.toUpperCase()]));
  assert.deepEqual(chrome, CHROME, 'editor chrome');
  // §§ 3 and 4: what each grammar scope resolves to.
  const wrong = SCOPES.flatMap(([scope, colour, style]) => {
    const got = resolve(theme.tokenColors, scope);
    return got?.foreground?.toUpperCase() === colour && (style === undefined || (got.fontStyle ?? '') === style) ? [] : [`${scope}: ${JSON.stringify(got)} (want ${colour}${style === undefined ? '' : ' ' + JSON.stringify(style)})`];
  });
  assert.deepEqual(wrong, [], 'scope colours');
  assert.deepEqual([theme.semanticTokenColors.keyword, theme.semanticTokenColors.function, theme.semanticTokenColors.class, theme.semanticTokenColors.string, theme.semanticTokenColors.comment],
    [P['syntax-violet'], P['syntax-azure'], P['syntax-blue'], P['syntax-amber'], P['text-muted']], 'semantic token colours');
  // Registered as a picker theme beside the others, with the default look unchanged; Dev Focus knows the id and the theme file.
  const config = await read('apps/web/src/lib/duwop-config.ts'), pack = await read('apps/web/src/lib/event-horizon-azure.ts'), client = await read('apps/dev/client.js');
  assert.match(config, /extraThemes: \[[^\]]*\.\.\.eventHorizonAzure[^\]]*\]/);
  assert.match(config, /defaultLook:[^\n]*event-horizon-prime/);
  assert.match(pack, new RegExp(`id: "${ID}"[\\s\\S]*dark: true`));
  assert.ok(client.includes(`'${ID}'`) && client.includes('./event-horizon-azure-theme.json'));
  for (const page of ['index.astro', 'phone.astro']) assert.match(await read('apps/web/src/pages/' + page), /import '\.\.\/lib\/event-horizon-azure\.css';/, page);
  console.log(`PASS azure contract: ${Object.keys(props).length} palette properties, ${Object.keys(CHROME).length} chrome colours, ${SCOPES.length} scopes`);
});
