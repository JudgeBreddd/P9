# Shell acceptance

The production Astro build loads through p9://app/. One React island owns the
approved markup and controller. No page router or view transitions.
Run test/desktop.test.mjs after pnpm build, or pnpm gate:4.

The must-pass test and D10 1–7 assert visible DOM state and literal expected values.
No production test globals or IPC bypasses exist. Hostile preload is test-only.
Malformed-argument coverage invokes the actual registered handler from the main
process test driver; the public bridge accepts no arguments.

Fixtures and edits die with the window. Live Mission, ACP, editor and terminal
integration remain later phases. Shell controls do not mutate workspace files.
