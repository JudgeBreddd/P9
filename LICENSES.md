# Dependency licences

Pinned by pnpm-lock.yaml. dependency-licenses.json enumerates the recursive Linux
installation, SPDX metadata and notice hashes. Entries marked installed:false
are platform-optional packages absent here. scripts/licenses.mjs verifies it.
Another target platform requires a regenerated inventory.
Hono and its Node adapter follow the existing agent-first-workspace backend pattern;
the handlers and security boundary here are new code.

| Runtime dependency | Version | Licence |
|---|---|---|
| hono | 4.13.13 | MIT |
| marked | 14.0.0 | MIT |
| @hono/node-server | 2.1.4 | MIT |
| astro | 7.4.0 | MIT |
| @astrojs/react | 7.1.0 | MIT |
| react / react-dom | 19.3.1 | MIT |
| electron | 44.7.2 | MIT plus bundled third-party notices |
| @agentclientprotocol/sdk | 1.8.0 | Apache-2.0 |
| @agentclientprotocol/claude-agent-acp | 0.88.0 | Apache-2.0 |
| @agentclientprotocol/codex-acp | 2.1.1 | Apache-2.0 (brings @openai/codex 0.159.3, Apache-2.0) |

The Claude adapter brings @anthropic-ai/claude-agent-sdk 0.3.293 and its native
claude-agent-sdk-linux-x64 binary, under Anthropic's own terms (their LICENSE.md and
README.md), not an open-source licence. P9 runs it locally with the user's own login
and does not redistribute it; Phase 13 packaging must decide whether a packaged app
may bundle it or must install it on first run. fast-sha256 (transitive) is Unlicense.

Vendored DUWOP: MIT, copyright 2026 itsdankai, from
[JudgeBreddd/DUWOP](https://github.com/JudgeBreddd/DUWOP/tree/f660e9d046c302d759f0fd8d3ceaa09c21721017)
main commit **f660e9d046c302d759f0fd8d3ceaa09c21721017**, after
[Prime PR 1](https://github.com/JudgeBreddd/DUWOP/pull/1) merged, including Anymouse #13.
Items installed: theme, command-center, boot, boot-astro, and gods (from commit 7bc53c2, 2026-10-19). duwop-source.json records
upstream paths/hashes. command-center.css differs only in comments (personal names removed). duwop-config.ts is customized: default Prime, AMOLED,
every theme offered, Command Center and Gods packs added, and local fonts. MIT text is in DUWOP-LICENSE.md.

Space Grotesk, Inter, JetBrains Mono, Fraunces, Orbitron, Cinzel, Pixelify Sans, Outfit, Chakra Petch and
Press Start 2P: pinned @fontsource and @fontsource-variable packages (5.3.0), OFL-1.1. Original notices remain in their installed packages. The app
serves these fonts locally; DUWOP never calls Google Fonts.

Astro's sharp build dependency includes libvips, LGPL-3.0-or-later. This source
checkout does not distribute a packaged app or libvips binary. Phase 13 packaging
must retain Electron LICENSES.chromium.html, dependency/font notices, and libvips
source/relinking terms if that build-only library is included.

Node 26.10.0 is the host runtime, distributed under the Node.js licence with bundled
third-party notices in its distribution. No Node binary is redistributed here.
pnpm 10.34.6 is the development package manager, MIT, not a runtime dependency.

Linux startup also invokes the host's util-linux flock command, observed version
2.42.4. Its [upstream command source](https://github.com/util-linux/util-linux/blob/master/sys-utils/flock.c)
is MIT; the operating-system distribution carries its linked-library and other
util-linux notices. No util-linux binary or source is redistributed here.
