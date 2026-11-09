# Local focus-time tracker

A small, local-only CLI time tracker for **Linux / Hyprland**, using a pinned
[x-win fork](https://github.com/PedDavid/x-win/tree/feat/hyprland-ipc). No server,
account, telemetry, or npm dependencies. This is a standalone experiment, not
Solidtime and not an integration with a hosted time-tracking service.

## Features

- Application-level foreground-time totals with manual pause/resume.
- Optional window-title breakdown (often reflects the active browser tab).
- Private atomic checkpoints every five seconds, with automatic recovery.
- Self-contained HTML reports with charts and excluded-time breakdowns.
- Synthetic tests covering accounting, title privacy, export and forced-kill
  recovery.

**Important:** this measures foreground-window time, not verified active work.
Automatic idle/lock detection, browser URLs and terminal foreground-command
attribution are **not implemented**. Pause before leaving or locking.

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

```sh
git clone --recurse-submodules https://github.com/PedDavid/time-tracker.git
cd time-tracker

# Pin Rust dependencies to the native build tested with this tracker.
cp native.Cargo.lock x-win/Cargo.lock
cargo build --manifest-path x-win/Cargo.toml --locked
cp x-win/target/debug/libx_win_napi.so x-win/target/debug/x-win.node

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
submodule or lockfile changed. Do not use `git submodule update --remote` unless
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

# A separate session history, with checkpoints every two seconds.
node poc/tracker.cjs --titles --state ./state/work.json --flush 2

# No checkpoint persistence at all.
node poc/tracker.cjs --no-state
```

Keys: **p** pause/resume, **r** refresh terminal report, **q** quit and export.
Ctrl+C also stops cleanly.

### What gets saved

Default checkpoint: `$XDG_STATE_HOME/focus-tracker/session.json`, falling back
to `~/.local/state/focus-tracker/session.json`. It contains totals, excluded time,
metadata and any explicitly opted-in titles. It is owner-readable/writable only.
The same command resumes saved totals; downtime is not counted. Use a new
`--state` path for a separate history. Title collection must use the same
`--titles` setting when resuming a checkpoint.

A sudden crash normally loses approximately the last checkpoint interval,
plus scheduling/I/O delay. Storage failures can prevent saving; warnings go to
stderr. This is a latest-state checkpoint, not a backup or an audit log.
Checkpoints are local to each computer; there is no automatic sync or merge.

Reports are written only when `--html` is supplied, and never overwrite an
existing file. The included [example report](poc/example-report.html) contains
**synthetic data only**. Download/open it locally to preview the design.
Generated reports, checkpoints, and binaries are Git-ignored. Custom filenames
without the usual extensions might not match ignore rules: always inspect
staged changes before publishing. Never commit personal activity history.

See [the detailed PoC guide](poc/README.md) for accounting semantics, recovery,
privacy, title limitations and manual acceptance checks.

## Test

```sh
# No compositor or native addon needed:
node --test poc/*.test.cjs

# After building the addon: synthetic native transport/subscription integration:
node x-win/examples/hyprland-subscription-test.cjs x-win/target/debug/x-win.node

# LIVE, sanitized native snapshot/subscription smoke test:
node x-win/examples/hyprland-smoke.cjs x-win/target/debug/x-win.node
```

Twenty PoC tests passed locally, including SIGKILL/restart recovery, concurrent
writer rejection, title opt-in boundaries, and HTML injection/overwrite checks.
Live checkpoint save/resume was also tested on Hyprland with zero IPC errors.

## Layout

- `poc/` — Node tracker, accounting, checkpoints, HTML rendering and tests.
- `x-win/` — pinned Git submodule; Rust library and N-API addon, maintained in
  [PedDavid/x-win](https://github.com/PedDavid/x-win).
- `native.Cargo.lock` — tested native dependency lockfile, copied into the
  submodule for the build.

The upstream x-win library is MIT-licensed; its license remains in the submodule.
