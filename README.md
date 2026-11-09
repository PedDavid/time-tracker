# Local focus-time tracker

A small, local-only CLI time tracker for **Linux / Hyprland**, using a pinned
[x-win fork](https://github.com/PedDavid/x-win/tree/feat/hyprland-ipc). No server,
account, telemetry, or npm dependencies. This is a standalone experiment, not
Solidtime and not an integration with a hosted time-tracking service.

## Features

- Application-level foreground-time totals with independent manual pause/resume.
- Automatic idle/lock gating on reviewed Hyprland versions, failing closed when
  activity signals are unavailable.
- Optional window-title breakdown (often reflects the active browser tab).
- Opt-in foot foreground-job executable tracking with explicit unknown fallbacks.
- Pi/Claude title-derived session labels when both foot and title tracking are on.
- Private atomic checkpoints every five seconds, with automatic recovery.
- Self-contained HTML reports with an expandable application tree, search,
  light/dark themes, charts and excluded-time breakdowns.
- Read-only HTML export from the latest checkpoint while tracking continues.
- Synthetic tests covering accounting, title privacy, export and forced-kill
  recovery.

**Important:** this measures foreground-window time, not verified active work.
Automatic idle/lock gating requires the local Wayland helper and reviewed
**Hyprland 0.56.2** lock capability. Missing/unsupported signals exclude time,
not silently count it. Idle cutoff defaults to five minutes of input inactivity;
pre-cutoff grace and polling/delivery latency can still be counted. Browser URLs
are not resolved. Foot foreground-job attribution is opt-in and best-effort;
shared-server windows and ambiguous jobs return unknown. See
[activity semantics and limitations](poc/docs/activity.md).

## Set up on another computer

Prerequisites (install separately if missing):

- Linux with a running Hyprland session; live-tested on Hyprland 0.56.2,
  x86_64 GNU Linux. Other compositors/platforms are not validated by this PoC.
- Node.js 22 or newer (locally tested with 26.13.0).
- A recent stable Rust/Cargo toolchain (locally tested with 1.99.1). Do not rely
  on the older MSRV declarations in upstream manifests; current dependencies
  require a newer compiler.
- Git, a C linker/build toolchain, pkg-config, and the Linux/XCB development
  libraries required by x-win; see [its build notes](x-win/README.md#linux).
- Linux `flock` (usually supplied by util-linux) for checkpoint locking.
- For automatic activity gating: a C compiler, `wayland-client` development
  files, `wayland-scanner`, and `wayland-protocols` containing ext-idle-notify v2.
  Nothing is installed or configured by the tracker.

```sh
git clone --recurse-submodules https://github.com/PedDavid/time-tracker.git
cd time-tracker

# Pin Rust dependencies to the native build tested with this tracker.
cp native.Cargo.lock x-win/Cargo.lock
cargo build --manifest-path x-win/Cargo.toml --locked
cp x-win/target/debug/libx_win_napi.so x-win/target/debug/x-win.node

# Build the small read-only Wayland idle helper (no downloads/installs).
sh poc/build-activity-helper.sh

# Run inside the intended Hyprland session, as your regular desktop user.
node poc/tracker.cjs
```

No npm/yarn install is required. Cargo downloads ordinary build dependencies
when needed. Build the native addon on each machine: the compiled `.node` file
is not committed and should not be copied between architectures or libc targets.
The commands above target Linux GNU; a musl build needs its own toolchain and
artifact path and has not been tested here.

If you cloned without submodules:

```sh
git submodule update --init --recursive
```

The submodule pins x-win revision
`ff3616ce5b95efea326792af86911599491d396c`, rather than depending on a moving
branch. `native.Cargo.lock` pins the root N-API crate's Rust dependency resolution.
To pull later tracker updates, use `git pull` followed by
`git submodule update --init --recursive`, then rebuild the native addon if the
submodule or lockfile changed. Rebuild the activity helper after its source or
Wayland protocol dependencies change. Do not use `git submodule update --remote` unless
you intentionally want an unpinned dependency revision.

## Use

```sh
# Track application totals, with crash-recovery checkpoints enabled.
node poc/tracker.cjs

# Opt in to window titles, then save an HTML report on exit.
# Titles may contain private text. Choose a fresh HTML filename for each run.
node poc/tracker.cjs --titles --html ./report.html

# Automatically stop and export after one minute.
node poc/tracker.cjs --titles --duration 60 --html ./minute-report.html

# Opt in to foot's foreground executable, in a separate session history.
# A fresh state path is required when changing title/foot collection settings.
node poc/tracker.cjs --foot --titles --state ./state/foot.json --html ./foot-report.html

# A separate session history, with checkpoints every two seconds.
node poc/tracker.cjs --titles --state ./state/work.json --flush 2

# Change the idle cutoff to one minute (seconds).
node poc/tracker.cjs --idle-timeout 60

# Explicit fallback on an unsupported desktop; pause manually before leaving.
# This disables automatic idle AND lock gating.
node poc/tracker.cjs --no-activity

# No checkpoint persistence at all.
node poc/tracker.cjs --no-state
```

Keys: **p** pause/resume, **r** refresh terminal report, **q** quit and export.
Ctrl+C also stops cleanly.

### Export without stopping the tracker

In another terminal, read its last atomically saved checkpoint:

```sh
node poc/export-report.cjs --html ./snapshot-report.html

# Match the writer's state path and privacy flags exactly:
node poc/export-report.cjs --state ./state/foot.json --foot --titles \
  --html ./foot-snapshot.html

# Keep one new HTML file updated every five seconds; Ctrl+R in the browser:
node poc/export-report.cjs --state ./state/foot.json --foot --titles \
  --html ./live-report.html --watch
```

Without `--watch`, export writes once and exits. With it, keep the exporter
running: it periodically replaces its own report. Ctrl+C stops watching;
restart with a new filename. No server or automatic browser refresh is needed.

This needs no native addon or compositor and does not acquire the writer lock,
change state, or add time after the saved snapshot. The HTML shows its as-of
time: normally around five seconds behind, potentially much older after failed
saves or a stopped tracker. Watch polling adds its own delay. Use a new output
filename each time you start an exporter. See
[live-checkpoint export](poc/docs/live-export.md).

### What gets saved

Default checkpoint: `$XDG_STATE_HOME/focus-tracker/session.json`, falling back
to `~/.local/state/focus-tracker/session.json`. It contains totals, excluded time,
metadata, explicitly opted-in titles and foot executable summaries. It is owner-readable/writable only.
The same command resumes saved totals; downtime is not counted. Use a new
`--state` path for a separate history. Collection must use the same
`--titles` and `--foot` settings when resuming a checkpoint.

A sudden crash normally loses approximately the last checkpoint interval,
plus scheduling/I/O delay. Storage failures can prevent saving; warnings go to
stderr. This is a latest-state checkpoint, not a backup or an audit log.
Checkpoints are local to each computer; there is no automatic sync or merge.

The tracker writes a report on exit only when `--html` is supplied; the separate
export command can create one during tracking. Neither claims a pre-existing
file; watch mode can only replace its own newly created report. The included
[example report](poc/example-report.html) contains
**synthetic data only**. Download/open it locally to preview the design.
Reports use a compact neutral theme shared with Clavium and Dominium. Expand an
application to inspect its observed window titles and, when enabled, foreground
executables. Pi/Claude executables can expand into correlated title-derived
labels. Search filters applications and details; **Expand all** and **Collapse
all** control the hierarchy. Clearing search restores the previous expansion.
The theme button switches between light and dark for the current report view.
Process rows use small selfh.st brand icons where available and neutral fallbacks
otherwise; titles and session labels remain text-only. Icons are embedded in the
report, with provenance and licensing in `poc/icons/README.md`. A compact footer
links to selfh.st and CC BY 4.0; hover, focus or tap its information button for
modification details. Credits travel with each report. Those links connect only
when clicked.

Application totals remain authoritative. Executable and title breakdowns overlap
and must not be added together; agent labels may cover only part of executable
time. Search does not change totals or percentages. These are observed labels,
not inferred projects or verified session identities. Reports make no network
requests and store no browser state. Native disclosure controls work with scripts
disabled; search, theme and bulk controls use one embedded, CSP hash-authorized
script. Optional details and charts are available in collapsible sections.

Generated reports, checkpoints, and binaries are Git-ignored. Custom filenames
without the usual extensions might not match ignore rules: always inspect
staged changes before publishing. Never commit personal activity history.

See [the detailed PoC guide](poc/README.md) for accounting semantics, recovery,
privacy, title limitations and manual acceptance checks. The
[foot association/design notes](poc/docs/foot-tracking.md) explain PTY proof,
process-group selection, polling, privacy and known limitations.
[Agent session labels](poc/docs/agent-session-labels.md) explain naming pi/Claude
sessions and the distinction between an observed title and verified session identity.

## Test

```sh
# No compositor or native addon needed:
node --test poc/*.test.cjs

# After building the addon: synthetic native transport/subscription integration:
node x-win/examples/hyprland-subscription-test.cjs x-win/target/debug/x-win.node

# LIVE, sanitized native snapshot/subscription smoke test:
node x-win/examples/hyprland-smoke.cjs x-win/target/debug/x-win.node
```

The PoC suite includes an optional browser check for the report tree. It runs
when Playwright is available, using `/usr/bin/chromium` (override with
`CHROMIUM_PATH`); no browser tooling is needed for the core tests.

All **81 original PoC tests passed** on the original developer workstation. Optional compiled helper tests use a
synthetic Wayland server and skip when development tools are unavailable.
The suite covers SIGKILL/restart recovery, concurrent writer rejection,
title opt-in boundaries, HTML injection/overwrite checks, synthetic foot
PTY/foreground-group attribution, activity gating and read-only live export.
Live checkpoint save/resume was also tested on Hyprland with zero IPC errors.

## Layout

- `poc/` — Node tracker, read-only C idle helper, accounting, checkpoints,
  offline/live-checkpoint HTML export and tests.
- `x-win/` — pinned Git submodule; Rust library and N-API addon, maintained in
  [PedDavid/x-win](https://github.com/PedDavid/x-win).
- `native.Cargo.lock` — tested native dependency lockfile, copied into the
  submodule for the build.

The upstream x-win library is MIT-licensed; its license remains in the submodule.
