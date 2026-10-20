// Anymouse: DUWOP's idea / bug / gripe box (@duwop/anymouse, the same box and limits), sending GitHub issues instead of
// Discord (Builder, 2026-10-15). With a token in the daemon a note becomes an issue on the P9 repo through the API, its
// kind as the label. Without one the reply carries GitHub's prefilled new-issue page; the desktop opens it in the
// browser, so the user files it under their own login. The token is read once at startup and never sent to a page.
export const REPO = 'JudgeBreddd/p9';
export const NEW_ISSUE = 'https://github.com/' + REPO + '/issues/new?';
const KINDS = { idea: 'Idea', bug: 'Bug', gripe: 'Gripe' };
const WINDOW = 10 * 60_000;
// A note saying @someone pings no one (DUWOP's allowed_mentions, in Markdown).
const quiet = (text) => text.replaceAll('@', '@​');

export function createAnymouse({ token, api = 'https://api.github.com', limit = 10 } = {}) {
  const recent = [];
  return async (input) => {
    const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const kind = Object.hasOwn(KINDS, b.kind) ? b.kind : 'idea';
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const page = typeof b.page === 'string' ? b.page.slice(0, 200) : '';
    if (!text) return { status: 400, error: 'write something first' };
    if (text.length > 2000) return { status: 400, error: 'keep it under 2000 characters' };
    const first = text.split('\n')[0];
    const title = quiet(KINDS[kind] + ': ' + (first.length > 80 ? first.slice(0, 79) + '…' : first));
    const body = quiet(text) + '\n\n---\nSent with Anymouse from P9' + (page ? ' (' + quiet(page) + ')' : '') + '.';
    if (!token) return { status: 200, open: NEW_ISSUE + new URLSearchParams({ title, body, labels: kind }) };

    const now = Date.now();
    while (recent.length && recent[0] < now - WINDOW) recent.shift();
    if (recent.length >= limit) return { status: 429, error: 'lots of notes just now, try again in a few minutes' };
    recent.push(now);
    try {
      const res = await fetch(api + '/repos/' + REPO + '/issues', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'content-type': 'application/json',
          'user-agent': 'P9-Anymouse', 'x-github-api-version': '2022-11-28' },
        body: JSON.stringify({ title, body, labels: [kind] }),
      });
      if (!res.ok) {
        console.error(JSON.stringify({ event: 'P9_ANYMOUSE_REFUSED', status: res.status }));
        return { status: 502, error: 'GitHub refused it (' + res.status + ')' };
      }
      const issue = await res.json();
      return { status: 200, ok: true, number: issue.number, url: issue.html_url };
    } catch {
      return { status: 502, error: "couldn't reach GitHub" };
    }
  };
}
