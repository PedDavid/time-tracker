# PRD 003: Hyprland support in x-win

**Status:** Proposed — implementation handoff
**Scope:** Standalone Rust library and Node/N-API bindings
**Primary target:** The user's Omarchy / Hyprland desktop

## Goal and scope decisions

Implement **Hyprland IPC support in x-win**, preserving existing public window
tracking APIs. Separately investigate opt-in attribution of the foreground
command inside a terminal. Neither milestone depends on an application
integration, time-tracking server, account system, or deployment.

The Solidtime experiment is abandoned. Do not build, integrate with, or submit
changes to Solidtime. This work is useful independently of any time tracker.
No Kubernetes changes, installs, desktop configuration changes, or external
publication are part of this implementation.

Do not implement generic Wayland protocol support in this iteration. A
Hyprland-specific backend can expose more information and has a smaller scope.
Ship basic window tracking independently of optional terminal enrichment.

## Repository and starting evidence

- Source: https://github.com/miniben-90/x-win
- Inspected commit: `a6ebeae`; refresh upstream before implementation and record
  the exact revision used.
- Rust library: `x-win-rs/`; Node/N-API bindings: root `src/`.
- Related issue: https://github.com/miniben-90/x-win/issues/70
- Assessment checkout may exist at `/tmp/x-win-assessment`; do not assume it
  survives handoff. Work in a separate checkout/branch, not vendored into infra.

Observed locally: Hyprland 0.56.2, `XDG_CURRENT_DESKTOP=Hyprland`.
`hyprctl -j activewindow` exposes address, title, class, PID, position, size,
fullscreen state, and more. Use synthetic fixtures, never private live titles.

Important distinctions:

- Hyprland IPC supplies PID **and geometry**.
- The generic `zwlr_foreign_toplevel_manager_v1` protocol proposed in #70
  supplies neither PID nor global geometry. Those limitations do not apply
  to this implementation.
- x-win already has `/proc` helpers for executable and memory information.
  Audit their units before reuse; do not mix a cross-platform unit change
  into this feature.
- Existing x-win Wayland routing is GNOME-oriented, not a generic backend.

## Phase 0 — baseline and API contracts

Read repository contribution instructions, build scripts, and tests. Capture
baseline results; distinguish existing failures from new regressions.

Inspect:

- `x-win-rs/src/linux/api.rs`: Linux routing.
- `x-win-rs/src/linux/api/wayland_api.rs`: existing GNOME path.
- `x-win-rs/src/linux/api/common_api.rs`: `/proc` helpers and Wayland detection.
- `x-win-rs/src/common/api.rs`: trait and empty-window conventions.
- `x-win-rs/src/common/x_win_struct/`: public data types.
- Root `src/lib.rs`: N-API exports and subscription loop.
- Root `src/common/thread.rs`: subscription lifecycle.
- Package scripts, native platform packages, and build/CI configuration.

Resolve/document before coding:

1. Meaning and units of `WindowInfo` fields and no-focus behavior.
2. Supported Hyprland versions, IPC framing/socket discovery, fullscreen field
   differences, and optional fields such as `stableId`.
3. Mapping compositor window identity into x-win's public `u32` ID.
4. Behavior on compositor disconnect, process exit, lock, and cancellation.

No system configuration changes are needed. If later desktop installation or
configuration work is requested, first load the Omarchy skill at
`/home/pedro/.pi/agent/skills/omarchy/SKILL.md`. Do not install dependencies or
change user settings without approval.

## Phase 1 — Hyprland window backend

### Routing and transport

Add a Linux backend, likely `hyprland_api.rs`, behind existing APIs. Select it
using compositor context/capabilities, not merely `WAYLAND_DISPLAY`. Leave
GNOME and X11 behavior intact. Unsupported compositors must not be misleadingly
reported as missing a GNOME extension.

Use **documented Unix-socket IPC directly** for steady-state queries.
`hyprctl -j` is useful for diagnosis, but do not spawn a subprocess on each
100 ms poll. Confirm discovery/framing against supported versions and use the
session runtime directory and instance signature. No insecure global `/tmp`
fallback, root permissions, or compositor configuration changes.

Separate response parsing from transport. Bound message sizes and socket
operations so an unresponsive compositor cannot hang consumers or shutdown.

### Map window metadata

Implement `get_active_window` and `get_open_windows` using existing types:

- Title and application class from compositor metadata.
- PID from Hyprland; executable metadata from existing `/proc` helpers.
- Position, dimensions, fullscreen state from IPC.
- Linux OS marker and documented memory units.
- Icon lookup or graceful empty/unsupported result consistent with callers.
  Do not infer browser URLs from titles.

Identity must be per window, **not per PID**. Multiple windows may share a
process. Do not truncate a compositor address into `u32` or hash without
collision handling. Use a session-lifetime address-to-ID mapping with cleanup,
or another explicit collision-safe strategy. Do not require optional new
compositor fields. Define behavior on reconnect and address reuse.

Handle `{}` / no focus, unknown JSON fields, malformed responses, close races,
native Wayland windows, and XWayland windows. An exited process or unreadable
`/proc` must not prevent returning otherwise valid compositor metadata.

### Subscription behavior

Reuse the polling subscription initially; no generic Wayland event loop is
required. Existing root `src/lib.rs` subscriptions compare ID/title, and an
error currently ends the subscription. Define reconnect/retry behavior so one
transient compositor failure does not silently end monitoring permanently.
Isolate any shared subscription changes and regression-test other backends.

Verify initial focus delivery, title-only updates, no-focus transitions,
restoration, repeated subscribe/unsubscribe, and bounded cancellation. Do not
retain stale activity through disconnects or lock; document any compositor
visibility limitations rather than claiming to implement idle detection.
Measure polling overhead before introducing additional architecture.

### Tests and acceptance

- Synthetic response fixtures: normal/no-focus, missing/unknown fields,
  fullscreen variants, malformed response, shared-PID windows.
- Mock socket: normal response, timeout, oversize/truncation, disconnect/retry.
- Mock `/proc` provider: missing PID, permission denied, process exits.
- Identity stable across title changes, distinct across windows, cleaned up
  safely after close/reconnect.
- Rust API and Node subscription demonstrated on real Hyprland.
- Existing GNOME/X11 routing and public data shapes remain compatible.
- No per-poll subprocess, unbounded blocking, or native panic on ordinary races.

Keep unit tests independent of a compositor. Label live integration tests and
report unavailable environments explicitly.

## Phase 2 — terminal attribution spike (optional, separate milestone)

Goal: given a terminal window, identify its **local foreground executable**
and optionally its project. Do not change the meaning of the owning window
PID or silently replace terminal metadata in the existing API.

First prove correct window-to-PTY association for the user's actual terminal
emulator. A window PID is not necessarily its shell PID. One emulator process
may own multiple windows/tabs, and the emulator typically holds the PTY master
while its child owns the slave.

Investigate process ancestry, controlling TTY/process-group metadata, available
`/proc/<pid>/fdinfo`, and emulator capabilities. Do not assume the deepest
child is active, scan the whole process tree and guess, or enable terminal
remote control automatically. Do not open a controlling TTY merely to call
`tcgetpgrp` without understanding permission and job-control consequences.

**If correct association cannot be proven, return unknown.** Treat that as a
valid limitation, not permission to misattribute another window's processes.
Review the spike before expanding to multiple emulators.

## Phase 3 — optional foreground-command API

Only after the association spike, propose an **additive, opt-in API** and
review its shape before implementation. Preserve existing `WindowInfo` and
Node bindings. Suggested model: optional terminal context containing resolved
executable, optional sanitized project label, source/confidence, and a
separate foreground PID where available. Keep the actual owner intact.

For a positively associated PTY:

1. Identify its foreground process group using terminal/proc metadata.
2. Enumerate group members, excluding background jobs.
3. Resolve executable and working directory best-effort.
4. Define deterministic behavior for pipelines/multiple foreground members.
5. Identify tools by executable/allowlist, not sensitive command arguments.
6. If the shell is foreground, report shell. Built-ins and internal agent
   tasks may be indistinguishable without separate shell integration.

Cache conservatively and protect against PID reuse using process start time.
Bound scans; do not spawn `ps`, `pstree`, `git`, or a shell on every poll.
Project lookup can walk `.git` markers, including worktree `.git` files, with
caching; it must not execute repository code or hooks.

A command can change without title/focus changing. Existing subscriptions
compare ID/title only. Define separate change detection for optional context;
do not forge window IDs or mutate titles to trigger callbacks. Poll terminal
context at a conservative configurable rate rather than rescanning everything
on every window query.

### Honest limitations

- `tmux` / `screen`: report multiplexer/unknown initially. Pane attribution
  needs explicit mapping of the focused client to active pane/PTY; never
  choose a descendant from the entire server process tree.
- `ssh`: report SSH locally; remote commands are not visible via local `/proc`.
- Containers, reparented processes, restricted `/proc`, ambiguous windows, and
  pipelines need explicit fallbacks, not invented certainty.

### Privacy

Do not collect full command lines, environment, output, or arbitrary arguments
by default. They may contain credentials, prompts, and private content. No
network requests, telemetry, command execution, or built-in persistence.

Project context must be separately opt-in. Avoid full paths in default output
and logs; prefer a display label. Use synthetic fixtures and never commit
real command lines or window titles. API docs must state what is inspected
and the limitations of inferred attribution.

### Terminal acceptance matrix

- Shell → Neovim → shell; shell → build/test command → shell.
- Background job never replaces a foreground command.
- Windows/tabs sharing an emulator PID never leak attribution.
- Pipeline selection/fallback is deterministic.
- Multiplexer and SSH limitations are explicit.
- Process exit, PID reuse, permissions, and association failure are safe.
- No behavior change when optional enrichment is off.
- Context changes are observable without title/focus changes.
- No sensitive arguments/full paths in default output or logs.

## Validation and deliverables

Use the checkout's package manager, lockfile, and documented Rust toolchain.
Confirm scripts before running. Starting points include:

- `cargo test --manifest-path x-win-rs/Cargo.toml` and root Rust checks.
- Package lint/tests and N-API native build.
- A small Node consumer demonstrating snapshot and subscription APIs on the
  real desktop, with sanitized output and no application integration.

Some existing tests require a live desktop; distinguish environmental skips
from implementation failures. Verify that Node loads the freshly built native
artifact rather than a previously installed platform package.

Deliver:

1. Reviewable Hyprland backend patch/PR, synthetic fixtures, API behavior notes,
   supported-version caveats, and test results. It is related to #70, **not**
   completion of generic Wayland support.
2. Reproducible standalone Rust/Node smoke-test instructions and exact revisions.
3. Separately reviewable terminal-association spike and optional API design;
   do not let enrichment delay basic Hyprland support.
4. Known limitations and a short upstream issue/PR draft, without publishing
   externally until approved.

No automatic installs, external issue/PR creation, package publication, or
commits. Preserve unrelated working-tree/staged changes. If committing in
infra is later requested, follow `AGENTS.md` and verified identity trailers.

## Next-agent execution order

1. Read this plan and upstream instructions; refresh source and baseline tests.
2. Settle IPC, window identity, and recoverable error contracts.
3. Implement/test the Hyprland backend in Rust and Node bindings.
4. Demonstrate it using a standalone consumer and report results.
5. If requested, investigate terminal association; review the additive API
   before implementing optional enrichment.
