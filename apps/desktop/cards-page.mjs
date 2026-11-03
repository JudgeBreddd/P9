// The page of the Dev Focus cards overlay (p9://cards/): a small transparent view stacked above the editor view, because a
// native view draws above the shell's HTML and the cards would sit under it. It draws what main hands it (text only, set with
// textContent) and says back which card was clicked and what size it is. It has no other power (preload: cards-preload.cjs).
export const CARDS_URL = 'p9://cards/';
const page = '<!doctype html><meta charset="utf-8"><title>Cards</title><link rel="stylesheet" href="cards.css"><div id="c"></div><script src="cards.js"></script>';
const css = `html,body{margin:0;background:transparent;overflow:hidden;font:12px system-ui,sans-serif;color:var(--foreground,#dce4f2)}
#c{display:flex;flex-direction:column;gap:8px;padding:0}
.card{position:relative;border-radius:11px;background:color-mix(in srgb,var(--card,#0b1020) 95%,transparent);border:1px solid var(--border,#26304a);box-shadow:0 4px 18px #0006}
.open{display:grid;grid-template-columns:auto 1fr;gap:3px 9px;align-items:center;width:100%;padding:7px 28px 7px 10px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:inherit;box-sizing:border-box}
.open .t,.open .s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.open .s{grid-column:2;color:var(--muted-foreground,#8b97ad);font-size:11px}
.n{min-width:16px;height:16px;border-radius:8px;background:var(--primary,#7aa2f7);color:var(--primary-foreground,#05070e);font-size:10px;font-weight:700;display:grid;place-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:var(--primary,#7aa2f7);margin:0 4px}
.x{position:absolute;top:4px;right:4px;width:20px;height:20px;border:0;border-radius:6px;background:none;color:var(--muted-foreground,#8b97ad);cursor:pointer;font:inherit;line-height:1}
.x:hover,.open:hover{background:color-mix(in srgb,var(--accent,#1b2440) 70%,transparent)}`;
const script = `const box = document.getElementById('c');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const size = () => window.p9cards.size(Math.ceil(box.getBoundingClientRect().height));
const draw = items => {
  box.replaceChildren(...items.map(c => {
    const card = el('article', 'card'), open = el('button', 'open'), x = el('button', 'x', '\\u00d7');
    open.append(c.n ? el('span', 'n', String(c.n)) : el('span', 'dot'), el('span', 't', c.title), el('span', 's', c.sub));
    x.title = 'Snooze to the Notification Center'; card.dataset.key = c.key;
    open.onclick = () => window.p9cards.act(c.key, 'open'); x.onclick = () => window.p9cards.act(c.key, 'x');
    card.append(open, x); return card;
  }));
  size();
};
const look = l => { for (const [k, v] of Object.entries(l.colors)) document.documentElement.style.setProperty('--' + k, v); };
window.p9cards.onList(draw); window.p9cards.onLook(look);
window.p9cards.ready().then(r => { if (r.look) look(r.look); draw(r.items); });`;
export const cardsSite = () => ({ files: new Map([['/index.html', Buffer.from(page)], ['/cards.css', Buffer.from(css)], ['/cards.js', Buffer.from(script)]]),
  csp: "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'" });
