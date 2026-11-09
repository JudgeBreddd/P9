// O17: the review fixture from the Event Horizon Azure spec (§ 9), as written there, and a contrast ratio for colours read
// from the real rendering (§ 8: "test contrast in actual rendering rather than assuming palette compliance").
export const AZURE = 'p9-event-horizon-azure';
const TS = `import { Hono } from 'hono';

interface Health { status: 'ok'; version: string }
const app = new Hono();
app.get('/api/health', (c) => {
  const healthy = true;
  return c.json({ status: 'ok', version: '1.0.0', healthy });
});

export default app;
`;
export const FIXTURE = { ts: TS, md: `# P9 — Agent Workspace

A unified, high-performance workspace for **AI-assisted** development.

## Features

- [x] Agent-first workflow
- [x] Integrated terminal
- [ ] Session continuity and recall

> A focused editor should feel calm, not fluorescent.

Read the [developer guide](https://example.com/docs) or run \`pnpm dev\`.

\`\`\`ts
${TS}\`\`\`

| Module | Status |
| --- | --- |
| Editor | Ready |
| Recall | Planned |
` };
// One small file per other language § 4 names, to record what each grammar (or its absence) gives.
export const OTHERS = {
  'data.json': '{ "name": "p9", "count": 42, "ok": true, "none": null }\n',
  'style.css': '.panel { color: var(--p9-text-primary); width: 42px; }\n',
  'run.sh': 'pnpm install --frozen-lockfile "./app"  # build\n',
  'app.py': '@cache\ndef load(path):\n    if path is None: return True\n    print("ok", 42)  # note\n',
};
export const RGB = {
  primary: 'rgb(220, 229, 241)', secondary: 'rgb(164, 177, 198)', muted: 'rgb(117, 131, 154)', violet: 'rgb(183, 122, 255)', violetDim: 'rgb(138, 99, 214)',
  azure: 'rgb(66, 199, 245)', azureDim: 'rgb(57, 155, 216)', blue: 'rgb(126, 169, 248)', amber: 'rgb(246, 187, 88)', mint: 'rgb(99, 217, 189)', subtle: 'rgb(40, 51, 72)',
};
// WCAG 2 contrast of two computed colours ("rgb(r, g, b)" or "rgba(...)"; alpha ignored: the colours compared here are opaque).
export function contrast(a, b) {
  const lum = colour => {
    const [r, g, bl] = colour.match(/[\d.]+/g).slice(0, 3).map(n => Number(n) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}
