# Socket login

## Sub-features
Owner-only Unix socket, desktop cookie, origin/host validation, CSRF; dormant TCP refuses all credentials.
## How to get to it (user POV)
The future desktop connects to the installed daemon. Phase 3 exposes an API only.
## Driving it with Node
`node --test test/server.test.mjs` probes each route and method, including raw upgrades.
## Gotchas
No public routes. No production TCP listener. The TCP fixture is isolated and closes after its test.
