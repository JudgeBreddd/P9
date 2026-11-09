// O37: colours for fenced code in replies and Markdown previews (threat model row 18). This module only cuts code into
// [text, class] pieces; helpers.mjs builds the HTML, passing every piece of text through esc(). Classes come only from
// CLASSES below; anything else is dropped and its text stays plain. Parsers are chunks of P9's own build, loaded on the
// first block that needs one; until it arrives (or if it fails) the block is drawn plain, as before.
const LANGS = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'ts', typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  py: 'py', python: 'py', json: 'json', jsonc: 'json', css: 'css', md: 'md', markdown: 'md',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
};
const CLASSES = new Set(['cc-comment', 'cc-punct', 'cc-keyword', 'cc-fn', 'cc-type', 'cc-string', 'cc-const', 'cc-regex',
  'cc-prop', 'cc-meta', 'cc-invalid', 'cc-heading', 'cc-strong', 'cc-em', 'cc-strike', 'cc-mark', 'cc-link']);
// ponytail: blocks over this many characters stay plain, so a huge paste never parses on the page's thread.
const MAX = 50000;

async function lezer(load) {
  const [{ tags: t, tagHighlighter, highlightCode }, parser] = await Promise.all([import('@lezer/highlight'), load()]);
  const hl = tagHighlighter([
    { tag: t.comment, class: 'cc-comment' },
    { tag: [t.punctuation, t.operator], class: 'cc-punct' },
    { tag: [t.keyword, t.self, t.modifier], class: 'cc-keyword' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'cc-fn' },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], class: 'cc-type' },
    { tag: [t.string, t.special(t.string), t.number, t.character, t.unit, t.color], class: 'cc-string' },
    { tag: [t.bool, t.null, t.atom], class: 'cc-const' },
    { tag: [t.regexp, t.escape], class: 'cc-regex' },
    { tag: [t.propertyName, t.attributeName, t.labelName], class: 'cc-prop' },
    { tag: [t.meta, t.annotation, t.processingInstruction], class: 'cc-meta' },
    { tag: t.invalid, class: 'cc-invalid' },
    { tag: t.heading, class: 'cc-heading' }, { tag: t.strong, class: 'cc-strong' }, { tag: t.emphasis, class: 'cc-em' },
    { tag: t.strikethrough, class: 'cc-strike' }, { tag: [t.link, t.url], class: 'cc-link' },
  ]);
  return code => {
    const out = [];
    highlightCode(code, parser.parse(code), hl, (text, cls) => out.push([text, cls]), () => out.push(['\n', '']));
    return out;
  };
}
// Shell has no Lezer parser: the legacy shell mode, run line by line over a small stream with the methods it calls.
// ponytail: CodeMirror's own StringStream would bring the editor's state package (78 KB gzipped) for these few lines;
// a mode that calls a method not here fails, and codePieces then draws its block plain.
class StringStream {
  constructor(string) { this.string = string; this.pos = this.start = 0; }
  eol() { return this.pos >= this.string.length; }
  sol() { return this.pos === 0; }
  peek() { return this.string.charAt(this.pos) || undefined; }
  next() { if (this.pos < this.string.length) return this.string.charAt(this.pos++); }
  eat(m) {
    const ch = this.string.charAt(this.pos);
    if (typeof m === 'string' ? ch === m : ch && (m instanceof RegExp ? m.test(ch) : m(ch))) { this.pos++; return ch; }
  }
  eatWhile(m) { const s = this.pos; while (this.eat(m)); return this.pos > s; }
  eatSpace() { const s = this.pos; while (/[\s ]/.test(this.string.charAt(this.pos))) this.pos++; return this.pos > s; }
  skipToEnd() { this.pos = this.string.length; }
  backUp(n) { this.pos -= n; }
  current() { return this.string.slice(this.start, this.pos); }
  match(p, consume = true) {
    if (typeof p === 'string') { if (this.string.substr(this.pos, p.length) !== p) return null; if (consume) this.pos += p.length; return true; }
    const m = this.string.slice(this.pos).match(p);
    if (!m || m.index > 0) return null;
    if (consume) this.pos += m[0].length;
    return m;
  }
}
async function stream(load) {
  const mode = await load();
  const STYLE = { keyword: 'cc-keyword', atom: 'cc-const', builtin: 'cc-fn', def: 'cc-type', attribute: 'cc-type',
    string: 'cc-string', quote: 'cc-string', number: 'cc-string', comment: 'cc-comment', operator: 'cc-punct', meta: 'cc-meta' };
  return code => {
    const out = []; const state = mode.startState();
    code.split('\n').forEach((line, i) => {
      if (i) out.push(['\n', '']);
      const s = new StringStream(line);
      while (!s.eol()) { const style = mode.token(s, state); out.push([s.current(), STYLE[style] ?? '']); s.start = s.pos; }
    });
    return out;
  };
}
const LOAD = {
  js: () => lezer(() => import('@lezer/javascript').then(m => m.parser.configure({ dialect: 'jsx' }))),
  ts: () => lezer(() => import('@lezer/javascript').then(m => m.parser.configure({ dialect: 'ts jsx' }))),
  py: () => lezer(() => import('@lezer/python').then(m => m.parser)),
  json: () => lezer(() => import('@lezer/json').then(m => m.parser)),
  css: () => lezer(() => import('@lezer/css').then(m => m.parser)),
  md: () => lezer(() => import('@lezer/markdown').then(m => m.parser.configure(m.GFM))),
  sh: () => stream(() => import('@codemirror/legacy-modes/mode/shell').then(m => m.shell)),
};

const ready = new Map(); // language id -> cutter function, or null while loading or after a failed load
// ponytail: a plain LRU of 300 blocks, keyed on the full code (each up to MAX characters); a chat with more blocks than that re-parses the oldest on redraw.
const cache = new Map(); // id + code -> pieces, newest last
let version = 0;
const listeners = new Set();
// Bumped when a parser arrives: callers that keep rendered HTML redraw once (controller.mjs mdOf, phone.ts block sig).
export const codeColoursVersion = () => version;
export const onCodeColours = fn => listeners.add(fn);

// The pieces of one complete block, or null: language off the list, block too big, or parser not here yet (asked for).
export function codePieces(lang, code) {
  // Own keys only: a label such as constructor or __proto__ must not find an inherited value and stay plain.
  const name = String(lang).toLowerCase();
  const id = Object.hasOwn(LANGS, name) && LANGS[name];
  if (!id || code.length > MAX) return null;
  if (!ready.has(id)) {
    ready.set(id, null);
    LOAD[id]().then(fn => { ready.set(id, fn); version++; for (const f of listeners) f(); }, () => {});
  }
  const fn = ready.get(id);
  if (!fn) return null;
  const key = id + '\0' + code;
  let pieces = cache.get(key);
  if (!pieces) {
    try { pieces = fn(code).map(([text, cls]) => [text, cls.split(' ').filter(c => CLASSES.has(c)).join(' ')]); }
    catch { return null; }
    cache.set(key, pieces);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  } else { cache.delete(key); cache.set(key, pieces); }
  return pieces;
}
