---
name: verify-p9
description: Verify P9 foundation Unix-socket API, guarded saves, login and doctor CLI in isolated real daemon instances. Use after Phase 3 backend changes; extend when clients exist.
---

# Verify P9 foundation

## Launch

From the app root, with Node 26.10.0, pnpm 10.34.6, util-linux flock and gitleaks installed:

    pnpm install --frozen-lockfile
    node --test test/diagnostics.test.mjs test/files.test.mjs test/server.test.mjs

These tests launch the actual apps/server/main.mjs through test/helpers.mjs, using
test-only temporary os.homedir substitutions and workspace/state/recovery directories. P9_READY signals readiness.
No installed service or real workspace is driven.

## Desktop shell

    pnpm build
    pnpm check
    node --test test/desktop.test.mjs

This drives the actual Electron client in a disposable profile, chromiumSandbox:true.
It checks live webPreferences, Linux renderer seccomp, exact bridge keys, CSP header
and blocked script, outside navigation/popup, a hostile renderer's IPC refusal,
and malformed arguments. It drives Look, all focus modes, draft/caret/scroll,
review Skip/Save, Make Primary and Notification Center. Leave test windows alone.
It closes only its own windows and removes its own profile. Set P9_SCREENSHOTS to
an absolute evidence directory to retain PNGs and checked preferences.
Manual launch: pnpm desktop --state "$P9_STATE"; omit state for offline sample data.
The footer labels the preview and actual daemon connected/unavailable status.

## Doctor

The diagnostics test invokes scripts/teh.mjs doctor with the instance state and an
exclusive bundle path, then reads the JSON and checks health and credential exclusion.
Run it first when startup looks wrong:

    node --test test/diagnostics.test.mjs

## Drive

Use the existing real HTTP harness, not direct internal state setters. See features/.
For storage faults and process death:

    node --test test/save-faults.test.mjs
    node --test test/startup.test.mjs

The startup tests refuse a second daemon under the same home for nested, disjoint
and aliased workspaces even with different XDG_STATE_HOME values, then kill the owner and check that a restart with fresh
runtime state can acquire ownership. A real-daemon sync barrier also proves SIGTERM
finishes an in-flight PUT and cleans its recovery record before exit.
The real ENOSPC cases use unprivileged mount namespaces with private 1 MiB tmpfs mounts;
it must fail visibly if this prerequisite is unavailable, never fill a host volume.

## Evidence

Capture stdout/stderr to a new file in the parent project's private Phase 3 evidence directory.
Read the resulting transcript and the tests' literal disk/response assertions.
The tests inspect real target and recovery files, JSON bodies, permissions and socket
responses. Fault injection occurs only in disposable child processes; the API has no
test hook. An exit code alone is insufficient. The final-check race is an accepted
limit and has its own reproduction, not a claimed protected case.

## Cleanup

The harness sends SIGTERM only to the daemon child it started and awaits exit. SIGKILL
tests kill only their own worker. A mount namespace disappears with that worker.
Temporary fixtures remain for inspection; never broadly delete temporary directories
or kill processes by name. Evidence outside fixtures survives teardown. Any manual
instance must be stopped by its recorded PID, never through the installed service.

## Helpers

test/helpers.mjs owns fixture creation, daemon readiness, authenticated HTTP and teardown.
test/save-worker.mjs is a fault worker driven only by save-faults.test.mjs.
The command entry points are the node --test invocations above; no extra helper CLI.
