# Doctor bundle

## Sub-features
Daemon health, unit state, event-name logs and runtime versions in one JSON file.
## How to get to it (user POV)
`pnpm teh doctor --state "$P9_STATE" --bundle "$P9_BUNDLE"`.
## Driving it with Node
`node --test test/diagnostics.test.mjs` launches a daemon, runs that CLI and reads the bundle.
## Gotchas
The destination must not exist. Arbitrary journal messages are omitted; this is intentionally not a raw log export.

A cleanup-failure save emits only P9_DRAFT_RETAINED. Doctor retains that event name
without extra fields and reports daemon.recoveryRecordCount. The diagnostics test
creates one published record and one temporary record, checks count 1 and verifies
neither record contents nor credentials enter the actual CLI bundle.
