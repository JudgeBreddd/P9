import { esc, md } from './helpers.mjs';
// Artifacts (item 19, threat model row 65). An agent marks one with a fenced block whose info string reads
//   ```<type> artifact [panel|pinned|full] [title words]
// type: html, svg, mermaid, jsx/tsx/react, md/markdown; any other language is a code artifact. No mode word = panel.
// The chat shows a chip in its place (mdReply, helpers.mjs); the block itself never runs in the chat. A viewer without
// this (an older P9, a terminal) shows it as ordinary code. Desktop (controller.mjs) and phone (phone.ts) share this file.
const KINDS = { html: 'html', svg: 'svg', mermaid: 'mermaid', jsx: 'react', tsx: 'react', react: 'react', md: 'markdown', markdown: 'markdown' };
export const ART_MODES = ['panel', 'pinned', 'full'];
export const KIND_NAMES = { html: 'HTML', svg: 'SVG', mermaid: 'Mermaid', react: 'React', markdown: 'Markdown', code: 'Code' };
export function artifactInfo(info) {
  const w = String(info ?? '').trim().split(/\s+/);
  if (w[1]?.toLowerCase() !== 'artifact' || !/^[\w+#.-]{1,32}$/.test(w[0])) return null;
  const mode = ART_MODES.includes(w[2]?.toLowerCase()) ? w[2].toLowerCase() : null, kind = KINDS[w[0].toLowerCase()] ?? 'code';
  return { kind, lang: w[0], mode: mode ?? 'panel', title: w.slice(mode ? 3 : 2).join(' ').slice(0, 120) || KIND_NAMES[kind] + (kind === 'code' ? ' · ' + w[0] : '') };
}
// The chip that stands in for the block: everything in it is escaped text, src included (a click reads it back from the dataset).
export const artifactChip = (a, src) => `<button type="button" class="artifact-chip" data-artifact data-kind="${esc(a.kind)}" data-lang="${esc(a.lang)}" data-mode="${esc(a.mode)}" data-title="${esc(a.title)}" data-src="${esc(src)}" title="Open the artifact"><span class="art-kind">${esc(KIND_NAMES[a.kind])}</span><span class="art-title">${esc(a.title)}</span></button>`;
export const chipArtifact = b => ({ kind: b.dataset.kind, lang: b.dataset.lang, mode: b.dataset.mode, title: b.dataset.title, src: b.dataset.src });
// Every artifact of a reply's text, in order (the newest opens by itself when the turn ends).
export const artifactsIn = text => {
  const out = [];
  md.walkTokens(md.lexer(String(text ?? '')), t => { const a = t.type === 'code' && artifactInfo(t.lang); if (a) out.push({ ...a, src: t.text }); });
  return out;
};

// What goes into the frame: one HTML document, and the names of the runtimes it needs (dist/frame/<name>.js, fetched by
// this page and handed over as text). Markdown goes through md (row 18: raw HTML shows as text, links are not links).
const STYLE = '<style>:root{color-scheme:light dark}body{font:14px/1.55 system-ui,sans-serif;margin:16px}pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,monospace}pre.mermaid{white-space:pre;text-align:center}svg{max-width:100%;height:auto}</style>';
const page = (body, more = '') => `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body>${body}${more}</body></html>`;
const inline = value => JSON.stringify(value).replace(/</g, '\\u003c'); // a string literal that cannot close its <script>
const fail = "e => parent.postMessage({ p9: 'frame', kind: 'error', text: String(e && e.message || e).slice(0, 500) }, '*')";
export function frameDoc(a) {
  if (a.kind === 'html') return { html: a.src, runtimes: [] };
  if (a.kind === 'svg') return { html: page(a.src), runtimes: [] };
  if (a.kind === 'markdown') return { html: page(md.parse(a.src)), runtimes: [] };
  if (a.kind === 'mermaid') return { runtimes: ['mermaid'], html: page(`<pre class="mermaid">${esc(a.src)}</pre>`,
    `<script>mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' }); mermaid.run().catch(${fail});</script>`) };
  // React: TypeScript turns the JSX into React.createElement calls in the frame, then the result runs as a script of its
  // own (no eval). It may import react and react-dom only; its default export (or first exported function) is rendered.
  if (a.kind === 'react') return { runtimes: ['react', 'typescript'], html: page('<div id="root"></div>', `<script>(() => { try {
  const out = ts.transpileModule(${inline(a.src)}, { fileName: 'artifact.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const mods = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOM, 'react/jsx-runtime': React };
  window.__artifact = { module: { exports: {} }, require: name => { if (name in mods) return mods[name]; throw new Error('An artifact can import react and react-dom only, not ' + name); } };
  const s = document.createElement('script'); s.textContent = '(function (module, exports, require) {\\n' + out + '\\n})(__artifact.module, __artifact.module.exports, __artifact.require);'; document.body.append(s);
  const x = __artifact.module.exports, C = typeof x.default === 'function' ? x.default : Object.values(x).find(v => typeof v === 'function');
  if (C) ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(C));
} catch (e) { (${fail})(e); } })();</script>`) };
  return { html: page(`<pre><code>${esc(a.src)}</code></pre>`), runtimes: [] };
}

// The frame: an <iframe sandbox="allow-scripts"> of the frame page (desktop p9://frame/, phone /frame/), which has its own
// CSP. This page and the frame talk only by postMessage, and each side checks the other's window and the message's shape.
// The frame's messages are treated as text and never as markup: an artifact can forge them, and gets nothing by it.
// Navigation: the frame page's CSP cannot stop the artifact sending its own frame elsewhere. The desktop refuses it
// (will-frame-navigate, the subframe request block); the phone has only this page's frame-src 'self', which the browser
// applies to the frame's own navigations too (a page on the phone's own server still loads, without its cookies). So a
// second load here (one is expected) means the artifact left: the frame goes back to the frame page, renders nothing
// more, and the panel says so.
const runtimes = new Map();
const runtime = (base, name) => {
  if (!runtimes.has(name)) runtimes.set(name, fetch(base + name + '.js').then(r => r.ok ? r.text() : Promise.reject(new Error('The ' + name + ' runtime did not load (' + r.status + ')')))
    .catch(error => { runtimes.delete(name); throw error; }));
  return runtimes.get(name);
};
// what: the word in the navigation message (a Mission card, row M5, says "card").
export function mountFrame(box, a, { page: src, base, onSelection, onState, what = 'artifact' }) {
  const frame = document.createElement('iframe'), { html, runtimes: need } = frameDoc(a);
  frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin, allow-forms, allow-popups or allow-top-navigation
  frame.className = 'art-frame'; frame.title = a.title; frame.src = src;
  const scripts = Promise.all(need.map(name => runtime(base, name)));
  let loads = 0, left = false;
  frame.addEventListener('load', () => {
    if (++loads < 2 || left) return;
    left = true; frame.src = src;
    onState?.('error', `The ${what} tried to open another page in its frame. P9 stopped it.`);
  });
  const hear = event => {
    if (!frame.isConnected) return removeEventListener('message', hear);
    const m = event.data;
    if (left || event.source !== frame.contentWindow || !m || m.p9 !== 'frame' || typeof m.kind !== 'string') return;
    const text = typeof m.text === 'string' ? m.text : '';
    if (m.kind === 'ready') scripts.then(list => frame.contentWindow?.postMessage({ p9: 'render', html, scripts: list }, '*'), error => onState?.('error', error.message));
    else if (m.kind === 'selection') onSelection?.(text.slice(0, 4000));
    else if (m.kind === 'rendered' || m.kind === 'error') onState?.(m.kind, text.slice(0, 500));
  };
  addEventListener('message', hear);
  box.append(frame);
  return frame;
}
// A Mission card (threat model row M5): a space file's HTML in this same frame. The appended rule gives it P9's light or
// dark theme (html.dark; the host's CSS sets the same color-scheme on the frame, so it stays see-through); :where keeps
// any color-scheme of the card's own ahead. A theme change shows on the card's next draw.
export const mountCard = (box, title, html, opts) => mountFrame(box, { kind: 'html', title,
  src: html + `<style>:where(:root){color-scheme:${document.documentElement.classList.contains('dark') ? 'dark' : 'light'}}</style>` }, { ...opts, what: 'card' });

// modes (desktop): [{ label, on, go }], the panel's Pin and Full screen toggles.
// Highlight and comment: select text in the frame, write a comment, Add; collect several; Send comments sends them as
// one ordinary user message (send: the host's composer path), each under its quote. Cancel clears them. Comments live in
// the state the host keeps, so a re-render or a reopen keeps them until they are sent or cancelled.
export const commentsText = (title, list) => `Comments on "${title}":\n\n` + list.map(c =>
  (c.quote ? c.quote.split('\n').map(l => '> ' + l).join('\n') + '\n\n' : '') + c.text).join('\n\n');
export function artifactView(box, state, { page, base, send, modes }) {
  const a = state.art;
  state.comments ??= []; state.sel ??= '';
  box.classList.add('art');
  box.innerHTML = `<div class="art-bar"><span class="art-kind">${esc(KIND_NAMES[a.kind])}</span><span class="art-title">${esc(a.title)}</span><span class="art-state" role="status"></span><span class="spacer"></span>${(modes ?? []).map((m, i) =>
    `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-art-mode="${i}" aria-pressed="${!!m.on?.()}">${esc(m.label)}</button>`).join('')}</div>
    <div class="art-body"></div>
    <form class="art-notes"><blockquote class="art-quote" hidden></blockquote><textarea rows="2" placeholder="Select text above, then comment on it" aria-label="Comment"></textarea>
    <div class="art-acts"><button type="submit" data-slot="button" data-variant="secondary" data-size="sm" data-art-add>Add comment</button><span class="spacer"></span>
    <button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-art-cancel>Cancel</button><button type="button" data-slot="button" data-size="sm" data-art-send>Send comments</button></div>
    <ol class="art-list"></ol></form>`;
  const $ = s => box.querySelector(s), quote = $('.art-quote'), ta = $('textarea'), list = $('.art-list'), status = $('.art-state');
  const show = () => {
    quote.hidden = !state.sel; quote.textContent = state.sel;
    list.replaceChildren(...state.comments.map((c, i) => {
      const li = document.createElement('li'), q = document.createElement('blockquote'), p = document.createElement('p'), x = document.createElement('button');
      q.textContent = c.quote; q.hidden = !c.quote; p.textContent = c.text;
      x.type = 'button'; x.textContent = '×'; x.title = 'Remove this comment'; x.setAttribute('aria-label', 'Remove this comment'); x.onclick = () => { state.comments.splice(i, 1); show(); };
      li.append(q, p, x); return li;
    }));
    $('[data-art-send]').disabled = $('[data-art-cancel]').disabled = !state.comments.length;
    $('[data-art-send]').textContent = state.comments.length > 1 ? `Send ${state.comments.length} comments` : 'Send comments';
  };
  const pressed = () => box.querySelectorAll('[data-art-mode]').forEach(b => b.setAttribute('aria-pressed', String(!!modes[b.dataset.artMode].on?.())));
  box.querySelectorAll('[data-art-mode]').forEach(b => b.onclick = () => { modes[b.dataset.artMode].go(); pressed(); });
  state.refresh = pressed;
  ta.value = state.draft ?? ''; ta.oninput = () => { state.draft = ta.value; };
  $('form').onsubmit = e => {
    e.preventDefault(); const text = ta.value.trim(); if (!text) return ta.focus();
    state.comments.push({ quote: state.sel, text }); state.sel = ''; state.draft = ta.value = ''; show();
  };
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); } };
  $('[data-art-cancel]').onclick = () => { state.comments = []; state.sel = ''; state.draft = ta.value = ''; show(); };
  $('[data-art-send]').onclick = async () => {
    if (!state.comments.length) return;
    const b = $('[data-art-send]'); b.disabled = true;
    if (await send(commentsText(a.title, state.comments))) { state.comments = []; state.sel = ''; }
    show();
  };
  mountFrame($('.art-body'), a, { page, base, onSelection: text => { if (text.trim()) { state.sel = text.trim(); show(); } },
    onState: (kind, text) => { status.textContent = kind === 'error' ? 'Error: ' + text : ''; status.dataset.kind = kind; box.dataset.rendered = kind; } });
  show();
}
