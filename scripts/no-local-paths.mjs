import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// No local paths (0.1.9): a PR's description, its commit messages and the lines it adds never name a place on one of the
// maintainers' machines (a home folder, a working copy outside the repo, private notes). Run on every PR by
// .github/workflows/no-local-paths.yaml, before each push by .githooks/pre-push, and by hand on a PR body before posting it:
//   node scripts/no-local-paths.mjs --body pr.md [--range <base>..<head>]
// Names that would be personal themselves (machines, accounts) are not written here: they come from the
// NO_LOCAL_PATHS_TERMS environment variable (the repo secret of that name in CI), comma separated, matched anywhere.
// --require-terms fails when that variable is empty; CI passes it on PRs from this repo (a fork PR gets no secrets,
// so there the run says the names were not checked instead of passing quietly).
const ok = '(?!(?:user|me|someone|runner)/)';
// The one exception (owner-approved, 2026-11-10): P9's own places in the home folder are the same on every machine,
// so they are product strings: its install folder, the default workspace by itself (never a folder inside it), and
// the named dot folders of the tools P9 works with. Any other home path is a maintainer's folder. The registry's
// workspace token is allowed on added code lines only, and also by itself.
// An allowed name must end there: a longer name that starts with one (a suffix, a hyphen) is someone's folder.
const end = '(?![\\w-]|\\.\\w)';
const dots = 'local|config|ssh|codex|claude|claude\\.json|cargo|nvm|bashrc|vscodium-server';
const home = `(?!\\.(?:${dots})${end}|(?:p9|P9)${end}|work${end}(?!/)|\\.\\.\\.)`;
export const RULES = [
  [new RegExp(`/ho${'me'}/${ok}[\\w.-]+/`), 'a home folder'] /* split: scan.mjs refuses the plain word in source */,
  [new RegExp(`/Users/${ok}[\\w.-]+/`), 'a home folder'],
  [/\/tmp\/claude-\d+/, 'a scratch folder'],
  [/\bp9-(?:sprint|n1|backups)\b|~\/repos\//, 'a working copy outside the repo'],
  [new RegExp(`~/${home}[\\w.-]`), 'a home folder'],
  [/\b20\d\d-\d\d-\d\d-\d{6}\b/, 'a dev-space run id'],
  [/_private\/\d|\breports\/phase\d/, 'private notes'],
  [/\bICM\//, 'a private workspace'],
  [/\/mnt\/raid/, 'a server disk'],
  [/[\w.+-]+@(?:gmail|outlook|hotmail|yahoo|icloud)\.com/i, 'a personal email'],
];
export function scan(text, where, { terms = [], code = false } = {}) {
  const hits = [];
  String(text).split('\n').forEach((line, i) => {
    const low = line.toLowerCase(), term = terms.find(t => low.includes(t));
    const checked = code ? line.replace(/~\/workspace(?![\w-]|\.\w|\/)/g, '') : line;
    const why = term ? 'a personal name' : RULES.find(([re]) => re.test(checked))?.[1];
    if (why) hits.push({ where: typeof where === 'function' ? where(i + 1) : `${where}, line ${i + 1}`, line: line.trim().slice(0, 160), why });
  });
  return hits;
}

// The lines a range adds, as { file, n, text }, from git diff -U0.
export function added(diff) {
  const out = []; let file = '', n = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l.replace(/^\+\+\+ (b\/)?/, '');
    else if (l.startsWith('@@')) n = Number(/\+(\d+)/.exec(l)[1]);
    else if (l.startsWith('+')) out.push({ file, n: n++, text: l.slice(1) });
  }
  return out;
}

function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
  const terms = (process.env.NO_LOCAL_PATHS_TERMS || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const body = arg('--body'), range = arg('--range'), hits = [], looked = [];
  if (body) { hits.push(...scan(readFileSync(body, 'utf8'), 'PR description', { terms })); looked.push('the PR description'); }
  if (range) {
    const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
    // Each commit on its own, not the range's net diff: a line added and removed again stays public in history.
    for (const c of git('log', '--format=%h%x1f%B%x1e', range).split('\x1e').map(c => c.trim()).filter(Boolean)) {
      const [sha, msg] = c.split('\x1f'); hits.push(...scan(msg, `commit ${sha} message`, { terms }));
      for (const a of added(git('show', '-U0', '--format=', '--no-color', '--no-ext-diff', '--first-parent', sha)))
        hits.push(...scan(a.text, () => `${a.file}:${a.n} (added in ${sha})`, { terms, code: true }));
    }
    looked.push(`the commits and added lines in ${range}`);
  }
  const unchecked = terms.length ? '' : ' Personal names: not checked (NO_LOCAL_PATHS_TERMS is empty).';
  if (unchecked && argv.includes('--require-terms')) {
    console.log(`No local paths:${unchecked} This PR comes from the repo, so the secret should be there.`); return 1;
  }
  if (!looked.length) { console.error('usage: node scripts/no-local-paths.mjs [--body <file>] [--range <base>..<head>] [--require-terms]'); return 2; }
  const report = hits.length
    ? [`No local paths: ${hits.length} found. Each names a place on someone's machine. Name the file only (phase2-o51.md, not its folder), or say it in words.`,
       ...hits.map(h => `  ${h.where}: ${h.why}\n      ${h.line}`)].join('\n')
    : `No local paths: none in ${looked.join(' or ')}.`;
  console.log(report + unchecked);
  return hits.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
