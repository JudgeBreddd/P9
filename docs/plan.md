# P9 plan: review findings, product direction, CI

Written 2026-11-03 from a read-only review of v0.1.6 (commit 1d1a6bf). Kept in the repo so the findings and the
direction are not lost between sprints. Tick items off here as they land; move a finding to "Done" with the commit.

## Done

- 9510449 (branch claude/awesome-albattani-wd0ixn): ledger `synchronous = NORMAL`; pets tick only while a pet or spinner
  is on screen; editor-host kill path uses the same slice as the start (`SLICE` in process-tree.mjs); `P9_LEDGER_FAILED`
  and `P9_UNHANDLED_REJECTION` logged instead of ending the daemon; the two fire-and-forget `useServer` calls report a
  failed install; xfer sha256 cache capped; the unused monaco environment override removed and two build-time monaco
  packages moved to devDependencies.

## 1. Performance, in order of payoff

Each item names the file, what it costs today and the fix. H/M/L is how much it costs at scale.

### Window (apps/web/src/controller.mjs)

1. **H. Mission Control re-renders on every chat event, even when hidden.** `renderTabs` ends in `renderCards`, which ends
   in `missionLive`, which rebuilds every win card, panel body and placed section (a `JSON.stringify` of the space and the
   whole `sectionBody` builder per section). The `written` WeakMap dedupes only the final DOM write. Fix: cut the
   `renderCards -> missionLive` edge; run `missionLive` from Mission's own data changes (`applyOverview`, `applyQueue`,
   toasts) and only when `S.focus === 'mission'` or a Mission modal is open. `renderCards` updates the bell and cards only.
2. **M. Streaming rebuilds the whole pane per chunk.** `paint()` with `only` still runs `pane(s)`: `shown(s)` builds 200
   events of HTML, `meters`, pickers, `chatItems` (an O(events) walk that also writes localStorage), then parses and syncs.
   `mdOf` caches by text, so the streaming message is re-parsed by `marked` on every chunk (O(n²) over a long reply).
   `event()` calls `lastIndexOf` per tool row. Fix: patch only the history column for streaming batches (the phone's
   `patch()` is the model), one repaint per animation frame, `chatItems` once per batch, a stable index on events.
3. **M. `placeDev` has no change detection and fires on every `open` attribute change in the document** (a
   MutationObserver on `document.body`; every tool row that opens itself while streaming runs 4-6 rects and an IPC
   `devView`). Fix: observe dialogs only; skip the IPC when the bounds are unchanged.
4. **M. Memory never shrinks.** `s.events` is never trimmed (TAIL bounds the draw only); `tool_call_update` finds its tool
   by linear scan; `chatImgs`, `view`, `S.docs`, `inlineSec`, `petSpots` keep entries for closed chats; the `timers` Set
   keeps cleared ids. Fix: per-session `toolsById`; drop old events for off-screen chats (Show earlier re-fetches); clear
   maps in `closeTab`.
5. **M. The dispose contract is incomplete.** Two bare `setInterval`s remain (usage poll, mission refresh), four
   `document.addEventListener` without `signal`, two observers unregistered, `showModal` monkey-patched and never
   restored. Fix: a wrapped `setInterval`, `{ signal }` everywhere, restore the prototype on abort.
6. **L-M. IPC calls without rejection handling leave UI stuck:** `loadDir` (dir stays "loading"), `loadMission` at boot
   (no retry on rejection), `loadGuide`, the `runLive` output loop, `launchLive`, `answerLive`, the first `liveChat.call`.
   Fix: one `ipc(action, payload)` wrapper that maps a rejection to `{ status: 503 }`.
7. **L-M. Shell.tsx polls status every 5 s with ~20 `getElementById` and unconditional writes**, even when connected.
   Fix: push status from main like `onServerUpdate`, or skip writes when the serialized result is unchanged.
8. **L. Assets.** `public/p9-icon.png` (499 KB) is the phone favicon, touch icon, manifest icon and launch tile; a 192/512
   set is ~20 KB. The 197 KB landing poster is assigned even when the landing is skipped. Four theme packs (~47 KB) load
   on both pages and could split per theme.

### Phone (apps/web/src/phone.ts)

9. **H. Every render and every keystroke scans every event of every chat several times.** `render()` runs `build`,
   `itemsOf` (JSON.stringify per block as its signature), `digest`, `turn`, `running`, `asking`, `queued` (a localStorage
   parse) and `renderPicks`, each a full pass over `state.events`, which holds all chats and grows on every poll. `label`
   runs on every composer `input`. Fix: bucket events per conversation at `pull()`/`take()`; make `digest` incremental (a
   pure left fold); memoize `build()` by (id, lastCursor).
10. **M. CodeMirror is imported and instantiated at module top** before the first screen. Fix: lazy `import('codemirror')`
    on first file open, with a stand-in like `term`.
11. **L. Draft written to localStorage per keystroke; queue JSON-parsed on every label/render.** Debounce the draft;
    keep the queue in memory with write-through.

### Daemon (apps/server)

12. **M. `chat.list()` runs the full History query to answer "is any turn running"** (four correlated subqueries per
    conversation plus `preview()`), every 15 s in background mode and every 2 s during an update, only for
    `.some(c => c.state === 'turn')`. Fix: `chat.turning()` as one `SELECT 1 ... WHERE state = 'turn' LIMIT 1`.
13. **M. Mission re-reads and re-parses registry + space on every call, often twice per request** (`registry()` in
    mission.mjs: two guarded reads, three parses, no cache; `/mission/data` calls it in `tile()` and again in
    `resolve()`; the desktop polls `/mission` every 20 s and each tile every 30 s). Fix: memoize by the two files' hashes
    (packages/files returns `hash`) like `plansCache`; pass the parsed registry from `tile()` into `resolve()`.
14. **M. `/mission/icons` ships every icon's bytes every 20 s** and the client discards the body when unchanged. Fix: a
    version key and `{ unchanged: true }`, or data URIs cached by mtime.
15. **M. Synchronous file I/O on request and stream paths in chat.mjs:** `keep()` (mkdirSync, writeFileSync, then
    readdirSync + statSync of every stored photo per photo sent), `fileImage` (up to 6 MiB read inside the ACP
    `sessionUpdate` handler), the images route (`readFileSync`). Fix: fs/promises; a running stored-bytes total so the
    sweep scans only when over the cap.
16. **L. Double serialization and poll fan-out:** `trim()` stringifies each update to measure it and `ledger.append`
    stringifies again; every `emit` wakes every long-poller. Fix: `trim` returns the text; coalesce wake-ups with
    `setImmediate`.
17. **L. `listDirectory` lstat's entries one at a time.** `Promise.all` in chunks of ~64, keeping the sort.
18. **L. `/health` scans the recovery folder on every call** and conflict records are never pruned. Cache the count,
    invalidate from `guardedSave`.
19. **L. Operation ledger growth:** every mutating reply buffered twice; week-old bodies nulled only at `openLedger`. Add a
    daily unref'd expiry.
20. **L. xfer `uploads` map on abandoned sends.** The client aborts in `finally`, so a map leaks only when a client dies
    mid-send. An idle-expiry sweep (an hour) closes it. Not a leak in normal use; do not delete on commit (commits are
    batched under one id).

### Desktop (apps/desktop)

21. **H. Startup is a serial chain of awaits with no window on screen** (main.mjs: `appSite()` reads the whole web dist
    including the 3.85 MB landing mp4, then `accountName()` reads /etc/passwd or runs `net user`, then four file reads
    and a pets lstat, then `new BrowserWindow`). Only `settings.zoom` and `sites.app` are needed to show it. Fix: create the
    window first (Electron paints the black background at once), `Promise.all` the reads, `accountName` lazily.
22. **M-H. The Dev Focus bundle is read into main-process memory and re-read on every reopen** (`assets('../dev/dist')`,
    tens of MB; `reopenDev` repeats it on Open Folder, workspace change, server switch, token refresh). Keep in-memory
    serving (a documented security choice); cache once, invalidate on rebuild.
23. **M. `p9:pets` list loads every sprite sheet (up to 8 MB each, up to 50) to return two strings**, on the landing page
    and every Settings open. Fix: a metadata-only reader.
24. **M. A new `app.once('will-quit')` per editor-host start attempt.** After a failed start every later Dev Focus open
    adds another handler; at quit each runs two `spawnSync('systemctl')` with 10 s and 5 s timeouts. One handler reading a
    `currentUnit` variable. (Plausible cause of the `--test-force-exit` ponytail on dev.test.mjs.)
25. **M. `server-update.mjs` polls /health plus /update/status every 2 s for up to 3 h over the tunnel.** Back off to
    ~10 s after a minute, or a `wait=` long-poll like `/chat/events`.
26. **L. `p9:dev-still` sends a full-resolution JPEG data URL on every top-bar menu open over Dev Focus.** Half width,
    lower quality.
27. **L. `scripts/teh.mjs` re-reads desktop.json on every call** (every long poll and status tick); `remote.mjs` does
    mkdirSync/lstatSync/chmodSync on every ssh spawn. Cache; re-read on 401/ECONNREFUSED.
28. **L. gate.mjs walks and reads the source tree three times per run;** `remote-install.mjs` passes every file under the
    agent packages as tar argv. One walk; `tar --files-from=-`.

### Dependencies and bundle

29. **M. React + ReactDOM ship in the desktop bundle to render one static string** (Shell.tsx renders shell.html via
    `dangerouslySetInnerHTML` once and a `useEffect` of plain DOM code; no other React component exists). Fix: inline
    shell.html in index.astro (phone.astro already does this) and run `mountShell` from a script; drop `@astrojs/react`
    from the web build. About 130 KB and one paradigm fewer.

## 2. Structure

The three big closures are the cost centre: nothing in them is testable without Electron, which is why the suite is
all end-to-end and takes 26 minutes.

### server.mjs (1132 lines, three concerns)

- Extract `settings.mjs` (`load()`, `mutate(change)`, `onChange`): the read/queue/replace machine is written three times
  (`useSpace`, `changeSettings`, `POST /setup/settings`).
- Extract `setup.mjs`: the wizard's filesystem heuristics (`existing`, `planFor`, `differing`, `wizardPaths`, ~190 lines
  with no HTTP in them). `setup-wizard.test.mjs` tests over HTTP, so this is behaviour-preserving.
- Extract `remote-listener.mjs` (`remoteListener()`, 145 lines; needs `auth`, `remote`, `api`, `onError`).
- `common.mjs` for the helpers duplicated across modules: `refused()` (four files), `wait()` (four), the UUID regex (six,
  plus a looser one in chat.mjs), `inside`/`within` (three), `sha256(file)` (move.mjs duplicates pieces.mjs), the
  `relative()` validators in move.mjs and xfer.mjs that differ in backslash handling.
- One `STATUS_OF` map for MCP errors instead of four inline tables.

### main.mjs (1871 lines, one closure, 64 IPC registrations)

- Split along the seams the comments already mark: `remote-session.mjs` (connect/useServer/setUp/runInstall/keeper + the
  12 remote handlers), `dev-focus.mjs` (openDev/reopenDev/serverEditor/cards + `p9dev:*`), `pets.mjs`,
  `start-watch.mjs` (goBack/quitting/startHealthy). Each takes an injected context `{ window, getState, getServerHost,
  sshCommand, ... }` and a shared `guard(event)`.
- Hoist `fromApp` (defined at :797, pasted inline 22 times); add `openUrl(url)` (9 copies), `UNAVAILABLE` (32 copies of
  the daemon-unavailable literal), `sleep` (12 copies across desktop and scripts).
- One `uploadPieces()` beside pieces.mjs for the three copies of the resumable piece loop (xfer, move, server-update);
  one `VERSION` regex in packages/protocol for the four of different strictness; one Node pin (`node-pin.json`) for
  install.sh, package-linux.mjs and package-windows.mjs.
- `scripts/` imports from apps/server and apps/desktop imports from scripts/, so scripts/ is a third shared package. It
  would be clearer as `packages/teh` with scripts/ left to true entry points.

### controller.mjs (3757 lines, one function, 14 short-named singletons)

Proposed modules with rough line counts: `dom.mjs` 60 (morph/sync/setHTML/addHalos/popover), `state.mjs` 80 (`S`, `M`,
`live`, lifetime/timer/observer registries, settings, names), `chat/events.mjs` 350 (`applyChat`, `editFiles`,
`history`, `loadChat`, `liveChat.*`), `chat/render.mjs` 330, `chat/compose.mjs` 120, `chat/files-panel.mjs` 170,
`cards.mjs` 170, `pets.mjs` 200, `modal.mjs` 140, `mission/data.mjs` 250, `mission/page.mjs` 400,
`mission/section.mjs` 140, `mission/modals.mjs` 330, `settings.mjs` 300, `wizard.mjs` 340, `landing.mjs` 150,
`dock.mjs` 110, `focus.mjs` 100, `move.mjs` 230, `files-pane.mjs` + `xfer.mjs` 120, `mock.mjs` 150 (sample-only code),
`controller.mjs` as a 100-line boot file. Modules talk through `state.mjs` plus a tiny event emitter (`chat:changed`,
`mission:changed`), which is also what fixes performance item 1. Each takes `{ S, lifetime, $ }` so it can be tested
with jsdom without Electron.

Desktop and phone duplication (about 550 controller lines with a ~450-line twin in phone.ts): the ledger-to-view
reduction, question form build and answer coercion, the slash menu, loose-mode confirm, queue persistence, attached
images, Mission section composition, sprint rings, usage meters, security settings, sign-in flow, onboarding. Next shared
modules in order of payoff: `chat-model.mjs` (one reducer from events to per-session view state, used incrementally by
both), `question-form.mjs`, `queue.mjs`, `mission-model.mjs`, `usage-meters.mjs`.

Order: server.mjs first (smallest, clearest seams), then main.mjs, then controller.mjs, each behind the existing
end-to-end tests, adding jsdom unit tests as modules come out.

## 3. Product direction: one workbench, not three apps

What VS Code and Claude Desktop have that P9 lacks is not a feature. It is that everything shares four things.

1. **One context.** Active folder, active file, selection and active chat, known to every mode. Today Dev opens a
   folder, each chat picks its own, Mission has a "main project", and none follows another.
2. **One command system.** Every action is a named command: in the palette, bindable, callable from anywhere. Today
   Ctrl K holds the maintenance buttons; no key switches focus mode, switches chat, opens a new chat, jumps to a file,
   toggles the side panel or focuses the composer; there are no right-click menus in the shell.
3. **One composable layout.** The Dev side chat is the proof it works; it stops there.
4. **Context flows between parts.** Select code and add it to the chat; the agent's edits as inline diffs in the editor
   with accept/reject per hunk; a changed file opens in the editor. Today the Changes tab is a read-only diff with no way
   into Dev, and no way to send a file or selection to a chat. This is the biggest gap: the two things the product is
   about do not talk.

Smaller gaps: go to file (Ctrl P) and workspace search from the shell; a status bar (branch, daemon health, running
agents, unsaved files, context used); git awareness outside Dev; chat history search by content; edit-and-resend and
forking; a UI to add MCP servers to chats; find in page in a chat; folder create/rename/delete in Dev; drag a file from
the files panel into the composer; @-mention of files in the composer.

Plan: when `state.mjs` and the event emitter come out of controller.mjs (section 2), make that state the shared context
and add a command registry beside it (every button and palette entry registers as a command with an optional key). The
first feature on it: open a changed file in Dev from the Changes tab, and send the current file or selection to the
active chat from Dev. Composable layout later.

## 4. CI: from 35 minutes a push to under 10

Measured on release/v0.1.6 (2026-11-03): Tests 27 min on one ubuntu-24.04 runner (setup is 45 s; the test step is all of
it: 723 tests, 122 files, `node --test` at the runner's default concurrency of 3). Installers in parallel: Windows x64
31 min (package 4 min, install/update/standard-user 8 min, local-feed update 5 min, rollback check 11 min), Windows
arm64 34 min (the "Windows file guard test" step takes 12 min there against 17 s on x64), AppImage 3 min. Both
workflows run on every push to every non-main branch, so a push is 35 minutes of wall clock and about 95 runner
minutes. That is why edits are batched into 30,000-line PRs, which is the real cost.

### Do first (an afternoon)

1. **Installers on demand, not on every push.** Keep the push trigger only for paths that change packaging:
   `scripts/package-*.mjs`, `scripts/bundle-daemon.mjs`, `scripts/installer.nsh`, `scripts/launcher/**`,
   `scripts/install-windows.ps1`, `scripts/windows-host.ps1`, `apps/desktop/updater.mjs`, `apps/desktop/rollback.mjs`,
   `package.json`, `pnpm-lock.yaml`, the workflow file itself. Everything else: tags and Run workflow (already there).
   The Windows unit steps (host, process-tree, terminal, notes, file guard, editor host, Dev folder) can move to a small
   `windows-tests` job in the Tests workflow that runs `node --test` on those files without building an installer.
2. **Shard the Tests job.** A matrix of 4 shards, each running a quarter of the files
   (`test/*.test.mjs` sorted, picked by index modulo 4), with the same setup steps. Tests already use per-instance temp
   homes and tmux sockets, so they shard cleanly. Expected: ~7-8 minutes per shard. A `timings.json` committed from a run
   (per-file duration) lets a later step bin-pack instead of round-robin.
3. **A fast tier that runs first and gates the rest.** 58 test files use neither Electron nor Playwright (server, files,
   ledger, chat over HTTP, mission, rollback, updater, phone-c18/c23 helpers). Run those as a `unit` job in ~3 minutes;
   run the Electron and browser shards only when it passes. On a red unit tier the answer arrives in 3 minutes, not 27.
4. **Path filters.** `paths-ignore: ['**.md', 'docs/**', 'LICENSES.md', 'third-party/**']` on the Tests workflow. Doc
   edits currently cost 35 minutes.
5. **Fix the flake.** D17 in agent-setup.test.mjs (a Ctrl+click on a URL wrapped across terminal rows returned only the
   second URL) has failed every push of release/v0.1.6 at 26 s, the slowest test in the run. A red suite nobody reads is
   worse than no suite.
6. **Look at the arm64 file guard step.** 12 minutes on windows-11-arm against 17 seconds on x64 is a hang or a timeout
   loop, not a slow machine.

### Then

7. **Rollback and local-feed checks nightly or on demand** (the `only=rollback` input exists): 16 minutes of the x64 job
   that do not change with a UI edit.
8. **Playwright and apt caching** are already cheap (4 s and 6 s); not worth more work.
9. **Local habit the fast tier enables:** `node --test test/<one file>` while editing, `pnpm test` rarely. The `gate:*`
   phases already exist for this; the fast tier is the CI mirror of `gate:3`.
10. **Small PRs.** With a 3-minute unit tier and 8-minute shards, a PR per finding is cheap; the next 30,000-line PR
    is the thing to avoid.

## 5. Suggested sequencing

1. Done: the quick-fix batch (above).
2. CI: items 1-5 of section 4. This changes how often everything else can be tested, so it goes before the next
   feature work.
3. Window render edges (performance 1-3) and the desktop startup reorder (21). The user-visible wins while streaming
   and at launch.
4. Phone event bucketing and lazy CodeMirror (9, 10); Mission memoization and the icon version key (13, 14); the
   `chat.turning()` query (12).
5. Structure, one file at a time (section 2): server.mjs, then main.mjs, then controller.mjs with `state.mjs` and the
   command registry from section 3.
6. The chat-to-editor link (section 3), the first feature on the shared context.
