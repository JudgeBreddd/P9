// The Mission edit form: the names and icons of apps, links and sections, saved through the daemon's /mission/edit
// (the MCP tools' own update(), with its guards: a stale hash is refused, never overwritten). With File protection on,
// the first Save only arms the button; the second sends the user's confirmation. A picture (the Picture button: the native file
// picker, then the bytes) is sent with that same Save; Remove goes back to the automatic icon.
const KINDS = { apps: 'app', pages: 'link', sections: 'section' };

// The rows for what Mission holds now: M is the controller's mission state ([title, desc, terminal, id, icon] apps,
// [title, url, id, icon] pages, {title, icon} sections).
export const editItems = (M) => [
  ...M.apps.map((a) => ({ kind: 'apps', key: a[3], title: a[0], icon: a[4] || '' })),
  ...M.pages.map((p) => ({ kind: 'pages', key: p[2], title: p[0], icon: p[3] || '' })),
  ...(M.space || []).map((s) => ({ kind: 'sections', key: s.title, title: s.title, icon: s.icon || '' })),
];

const WORDS = { 'hash-conflict': 'The file changed since this form opened. Nothing was saved.', 'registry-read-only': 'File protection is on, so P9 did not write it.',
  'duplicate-section': 'Another section already has that title.', 'invalid-record': '', 'unknown-id': 'It is no longer in the file.', 'unknown-section': 'It is no longer in the file.',
  'picture-too-big': 'That picture is over 256 KB.', 'picture-type': 'Use a PNG, JPEG, WebP, ICO or SVG picture.', 'picture-unreadable': 'P9 could not read that file.' };
const why = (r) => WORDS[r.body?.error] || r.body?.detail || r.body?.error || 'status ' + r.status;

// m: the modal ({kind: 'medit', items, draft, state, armed, stale, msg}); deps: the controller's helpers.
export function editorModal(m, body, foot, { mission, pick, art, esc, toast, again, reload }) {
  if (!m.state) {
    m.state = false; // loading
    mission('editState').then((r) => { m.state = r.status === 200 ? r.body : null; m.error = r.status === 200 ? '' : why(r); again(); });
  }
  m.draft ||= m.items.map((item) => ({ title: item.title, icon: item.icon }));
  m.msg ||= {};
  if (m.state === false) { body.innerHTML = '<p class="sm muted">Loading…</p>'; return; }
  if (!m.state) { body.innerHTML = `<p class="sm" role="status">Could not open the editor (${esc(m.error)}).</p>`; return; }
  const file = (item) => (item.kind === 'sections' ? 'space' : 'registry');
  // The picture now shown for a row: the one just chosen (or removed), else the stored one the daemon sent for the tile.
  const shown = (item, draft) => (draft.pic === '' ? null : draft.pic ? `data:${draft.pic.mime};base64,${draft.pic.data}` : item.shot !== undefined ? item.shot : art()?.[item.kind]?.[item.key]?.picture || null);
  body.innerHTML = `<div class="review" data-medit><p class="sm muted">Change what an app, link or section is called, and give it an icon: an emoji, or up to 16 characters with no spaces. Leave the icon empty for the lettered default. A picture of your own (PNG, JPEG, WebP, ICO or SVG, up to 256 KB) shows instead of the icon; Remove goes back to the automatic icon.</p>`
    + (m.state.protection ? '<p class="sm" data-medit-protect>File protection is on. Saving still changes the file, after you confirm it.</p>' : '')
    + (m.stale ? '<p class="sm" role="status" data-medit-stale><b>The file changed since this form opened.</b> Nothing was saved. <button data-slot="button" data-variant="outline" data-medit-reload>Reload</button></p>' : '')
    + m.items.map((item, i) => `<div data-row="${i}" style="display:flex;gap:8px;align-items:center;margin:6px 0"><span class="kind">${KINDS[item.kind]}</span>`
      + `<input data-slot="input" data-t aria-label="Title" value="${esc(m.draft[i].title)}"><input data-slot="input" data-ic aria-label="Icon" maxlength="16" size="6" placeholder="icon" value="${esc(m.draft[i].icon)}">`
      + (shown(item, m.draft[i]) ? `<img data-pic-img src="${esc(shown(item, m.draft[i]))}" alt="" width="24" height="24">` : '')
      + `<button data-slot="button" data-variant="outline" data-pic>Picture</button>` + (shown(item, m.draft[i]) ? '<button data-slot="button" data-variant="outline" data-pic-remove>Remove</button>' : '')
      + `<button data-slot="button" data-save>${m.armed === i ? 'Confirm save' : 'Save'}</button><span class="sm muted" role="status" data-msg>${esc(m.msg[i] || '')}</span></div>`).join('') + '</div>';
  foot.innerHTML = '';
  body.querySelectorAll('[data-medit-reload]').forEach((b) => b.onclick = () => reload(false));
  body.querySelectorAll('[data-row]').forEach((row) => {
    const i = +row.dataset.row, item = m.items[i];
    row.querySelector('[data-t]').oninput = (e) => { m.draft[i].title = e.target.value; m.armed = null; };
    row.querySelector('[data-ic]').oninput = (e) => { m.draft[i].icon = e.target.value; m.armed = null; };
    row.querySelector('[data-pic]').onclick = async () => {
      const r = await pick().catch(() => ({ error: 'picture-unreadable' }));
      if (!r) return; // cancelled
      if (r.error) m.msg[i] = why({ body: r }); else { m.draft[i].pic = r; m.msg[i] = 'Press Save to use this picture.'; }
      m.armed = null; again();
    };
    row.querySelector('[data-pic-remove]')?.addEventListener('click', () => { m.draft[i].pic = ''; m.msg[i] = 'Press Save to go back to the automatic icon.'; m.armed = null; again(); });
    row.querySelector('[data-save]').onclick = async () => {
      const change = {};
      if (m.draft[i].title !== item.title) change.title = m.draft[i].title;
      if (m.draft[i].icon !== item.icon) change.icon = m.draft[i].icon;
      const pic = m.draft[i].pic;
      if (pic === '') { if (shown(item, { pic: undefined })) change.picture = ''; else m.draft[i].pic = undefined; } else if (pic) change.picture = { data: pic.data };
      if (!Object.keys(change).length) { m.msg[i] = 'Nothing changed.'; return again(); }
      if (m.state.protection && m.armed !== i) { m.armed = i; m.msg[i] = 'Press Confirm save to change the file.'; return again(); }
      const r = await mission('edit', { kind: item.kind, key: item.key, ...change, hash: m.state[file(item)], ...(m.state.protection ? { confirm: true } : {}) });
      m.armed = null;
      if (r.status !== 200) {
        m.msg[i] = why(r);
        if (r.status === 409) m.stale = true;
        return again();
      }
      m.state[file(item)] = r.body.hash;
      Object.assign(item, { title: m.draft[i].title, icon: m.draft[i].icon });
      if (pic !== undefined) { item.shot = pic ? `data:${pic.mime};base64,${pic.data}` : null; m.draft[i].pic = undefined; }
      if (item.kind === 'sections') item.key = item.title;
      m.msg[i] = 'Saved.';
      toast({ kind: 'saved', txt: item.title, level: 'ok' }, true);
      await reload(true);
    };
  });
}
