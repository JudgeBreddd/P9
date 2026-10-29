// Mission data tiles and links (M3, threat model row 70), drawn the same on the desktop and the phone. What a tile's script
// printed is text: every value goes through esc, and a list row's link becomes a link only when it is http(s).
const web = (url) => typeof url === 'string' && /^https?:\/\/[^\s]+$/.test(url);
const host = (url) => { try { return new URL(url).host; } catch { return ''; } };

// r: the daemon's answer ({ shape } or { why, printed }), { allow: script title } before the user's Allow, { error }, or nothing yet.
// what: the word for it in the text ('card' for a Mission card, row M5).
export function tileHtml(r, esc, what = 'tile') {
  if (!r) return '<p class="tile-note">Loading…</p>';
  if (r.allow) return `<p class="tile-note">Runs ${esc(r.allow)} every 30 s while Mission shows this ${what}.</p><button type="button" class="tile-allow" data-tile-allow>Allow</button>`;
  if (r.error) return `<p class="tile-note">Could not run it: ${esc(r.error)}</p>`;
  if (r.why) return `<p class="tile-note">This ${what}'s script ${esc(r.why)}${r.printed ? ':' : '.'}</p>${r.printed ? `<pre class="tile-printed">${esc(r.printed)}</pre>` : ''}`;
  const s = r.shape;
  if (s.type === 'stat') return `<p class="tile-stat"><b>${esc(s.value)}</b>${s.unit ? `<span>${esc(s.unit)}</span>` : ''}</p>${s.label ? `<p class="tile-note">${esc(s.label)}</p>` : ''}`;
  if (s.type === 'list') return s.rows.length ? `<ul class="tile-list">${s.rows.map(x => `<li>${web(x.link) ? `<a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer" data-tile-link>${esc(x.title)}</a>` : `<span>${esc(x.title)}</span>`}`
    + `${x.badge !== undefined ? `<em>${esc(x.badge)}</em>` : ''}${x.subtitle ? `<small>${esc(x.subtitle)}</small>` : ''}</li>`).join('')}</ul>` : '<p class="tile-note">Nothing listed.</p>';
  if (s.type === 'table') return `<div class="tile-table"><table><thead><tr>${s.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
    + `<tbody>${s.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return `<div class="tile-rings">${s.rings.map(x => `<figure><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.9" pathLength="100"/>`
    + `<circle cx="18" cy="18" r="15.9" pathLength="100" stroke-dasharray="${Math.round(x.percent)} 100"/></svg><b>${Math.round(x.percent)}%</b><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>`;
}

// A space link (threat model rows 74, 75): only a plain http(s) link is an anchor. Another scheme, or a link that asks for text,
// is a button the desktop sends to the daemon (it checks page_schemes, shows the link and asks); where nothing opens it, words.
export const linkHtml = (l, esc, open = true) => web(l.url) && !l.ask
  ? `<a class="tile-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-tile-link><span>${esc(l.title)}</span><small>${esc(host(l.url))}</small></a>`
  : open ? `<button type="button" class="tile-link" data-weblink="${esc(l.id)}"><span>${esc(l.title)}</span><small>${l.url.startsWith('obsidian:') ? 'Opens in Obsidian on this computer' : 'Opens another program on this computer'}</small></button>`
    : `<span class="tile-link" data-weblink-off><span>${esc(l.title)}</span><small>Open it in the P9 desktop app</small></span>`;

// The daemon's reply to a tile's ask, as tileHtml takes it.
export const tileAnswer = (status, body) => status === 200 ? body : body?.error === 'allow-required' ? { allow: body.script } : { error: body?.detail || body?.error || String(status) };

// Quick note (threat model row 76), the same on the desktop and the phone: the title is the file name (characters a file name or
// Obsidian cannot hold become spaces), saved as one new .md in the section's folder; an existing name is refused, never replaced.
export const quickNotePath = (folder, title) => {
  const name = String(title).replace(/[\x00-\x1f\x7f\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim();
  return name ? folder + '/' + name + '.md' : '';
};
export const quickNoteHtml = (esc, qn, v = {}, desk = false) => `<form class="quick-note" data-quicknote><h3>Quick note</h3>`
  + `<label>Title<input name="title" maxlength="100" autocomplete="off" value="${esc(v.title || '')}"${desk ? ' data-slot="input"' : ''}></label>`
  + `<label>Note<textarea name="body" rows="5" maxlength="60000"${desk ? ' data-slot="textarea"' : ''}>${esc(v.body || '')}</textarea></label>`
  + `<p class="tile-note" role="status" data-qn-status>${esc(v.status || 'Saved as a new note in the ' + qn.path + ' folder. A note with the same title is never replaced.')}</p>`
  + `<button type="submit"${desk ? ' data-slot="button"' : ''}>Save to ${esc(qn.path.split('/').pop())}</button></form>`;
export const quickNoteWords = (r, file, qn) => r.status === 201 ? 'Saved ' + file + '.'
  : r.body?.error === 'exists' ? 'A note named ' + file.split('/').pop() + ' is already there. Nothing was replaced: change the title.'
    : r.body?.error === 'no-such-folder' ? 'The vault has no ' + qn.path + ' folder. Make it in Obsidian, then save again.'
      : r.body?.error === 'unknown-root' || r.body?.error === 'root-not-set' ? 'Pick the vault folder in the P9 desktop app first.'
        : r.body?.error === 'too-large' ? 'The note is over 64 KB. Make it shorter.' : 'Not saved (' + (r.body?.error || r.status) + ').';
