# Workspace files

## Sub-features
Text reads, locked paths, atomic replacement, detected-conflict comparison data and durable JSON recovery records.
## How to get to it (user POV)
File routes are API-only until a later client phase.
## Driving it with Node
`node --test test/files.test.mjs test/save-faults.test.mjs` reads literal disk output and writes through the authenticated API. A competing edit gets 409 with disk/draft content; a resolved save against diskHash gets 200 and replaces the actual target. Fault tests cover full storage, process death, paths and serialization.
Pre-PUT symlink, binary, oversize, hardlink, parent-link and moved-root cases return 409 with path-conflict records and no disk content. Initial unreadable targets retain a draft with API 403. Initial I/O and descriptor errors retain a draft with API 500 or 507. Overlong UTF-8 components and invalid input return 400 with no new record. Ancestor-root symlink swaps refuse GET and PUT.
## Gotchas
Independent same-user writes after the final check can be overwritten. Linux only; no power-loss proof. Recovery IDs are opaque and draft content is returned inline. Read each recovery record's path, hashes, reason and createdAt from disk; save-pending may already match the target and saved identifies a completed save whose cleanup failed. A deleted target gets 409 without recreation. Shared full storage gets 507 without a draft claim; separate recovery storage retains the draft. Monaco comparison UI is a later phase.
