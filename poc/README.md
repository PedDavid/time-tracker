# Local focus-time tracker PoC

A Node CLI with no npm dependencies, using the local **x-win Hyprland fork**. No server,
account, database, or network requests. Private local checkpoints now preserve
progress automatically (opt out with `--no-state`). This directory
is maintained in [PedDavid/time-tracker](https://github.com/PedDavid/time-tracker),
separate from the x-win fork pinned as a submodule. See the [root setup guide](../README.md)
for cloning and prerequisites on another machine.

## Run

From the repository root, inside your Hyprland session:

```sh
# Build the pinned fork; no npm install required.
cp native.Cargo.lock x-win/Cargo.lock
cargo build --manifest-path x-win/Cargo.toml --locked
cp x-win/target/debug/libx_win_napi.so x-win/target/debug/x-win.node

# Start tracking and switch between your applications.
node poc/tracker.cjs
```

Controls (single keys in an interactive terminal):

- **p** — pause/resume (pause before leaving or locking).
- **r** — refresh the report immediately.
- **q** or **Ctrl+C** — stop, print final totals, and write HTML if requested.

Summaries update every two seconds. Time is grouped by application class, so
multiple windows of the same application share a bucket. The currently focused
application is shown; focus on the terminal itself will count as terminal time.
Use `--duration` to start a timed run, then switch to another application.

```sh
# Try 60 seconds of normal app switching.
node poc/tracker.cjs --duration 60

# Final machine-readable report, with default automatic checkpoints.
node poc/tracker.cjs --duration 30 --json

# Entirely ephemeral run (no checkpoint or HTML file).
node poc/tracker.cjs --duration 30 --json --no-state

# Save a standalone HTML report when the session ends.
node poc/tracker.cjs --duration 60 --html ./focus-report.html

# Opt in to title details, e.g. a browser's current tab/window title.
# WARNING: titles can contain private content; the report will contain them.
node poc/tracker.cjs --duration 60 --titles --html ./focus-details.html

# Track foot foreground root executables (separate fresh checkpoint policy).
node poc/tracker.cjs --foot --titles --state ./state/foot.json --html ./foot-report.html

# Adjust polling/report frequency, independently of foot refresh.
node poc/tracker.cjs --foot --state ./state/foot-no-titles.json --foot-interval 1000 --interval 250 --refresh 5

# Explicit alternative locally built native artifact.
node poc/tracker.cjs --native /absolute/path/to/x-win.node

node poc/tracker.cjs --help
```

Copying `native.Cargo.lock` into the submodule makes the first build work with
`--locked`, even on a fresh checkout. The native artifact is explicitly loaded
by path; this cannot silently use an installed platform package.

## Crash recovery and checkpoint flushing

By default the tracker saves a private JSON checkpoint every **5 seconds**, on
pause/resume, and on clean exit (q, Ctrl+C, SIGTERM). It also tries a synchronous
final flush on ordinary Node exit/uncaught exceptions. The default file is:

```text
$XDG_STATE_HOME/focus-tracker/session.json
# or, when XDG_STATE_HOME is unset:
~/.local/state/focus-tracker/session.json
```

The next run automatically resumes those application totals and any opted-in
titles. **Stopped time is not counted**, and the old focused app/title is never
restored as current activity: a new native observation is required. Manual
pause status is preserved. Elapsed time means accumulated recorded runtime,
not wall time since the first start. Existing running processes won't acquire
this feature until restarted; the previous in-memory history cannot be
reconstructed if the old process crashes.

```sh
# Explicit session file and a shorter checkpoint interval:
node poc/tracker.cjs --titles --state ./private-session.json --flush 2

# Restart the exact same command to resume.
# To start separate totals, use a new --state filename.
```

Checkpoint files and lockfiles are `0600`; new storage directories are `0700`.
Save writes a unique same-directory temporary file, fsyncs it, atomically renames
it over the checkpoint, then fsyncs the parent directory. If the process dies
mid-write, the checkpoint should be either the previous or new complete JSON,
not a half-written file. Orphan temporary files after SIGKILL are not loaded;
they may be removed later when no tracker uses that session. They also have
owner-only permissions.

A kernel advisory lock prevents two tracker processes from updating one state
file. This requires the existing Linux **`flock`** utility; it is invoked only
once at startup, not per poll/flush. The lock is released automatically even
on SIGKILL, so there is no PID-file/stale-lock guessing. The `.lock` file itself
remains; **do not delete it while a tracker is running**. Use local filesystems
with normal POSIX flock/rename/fsync semantics, not a shared network/sync folder.
Never manually replace a live checkpoint or lock.

SIGKILL, power loss and severe native crashes cannot run cleanup. Normally the
loss window is approximately the checkpoint interval (5 seconds by default),
plus scheduling/I/O delay. This is not a hard guarantee under storage failures,
filesystem damage, full disks or hardware that ignores flushes. Periodic write
failures warn on stderr; tracking continues, but recent totals are not protected.
A failed final flush gives a nonzero exit status. Keep backups for long-term
history: this is a latest-state checkpoint, not an append-only audit log.

Corrupt, oversized (>16 MiB), incompatible or symlink checkpoints are rejected,
not silently reset. Preserve/recover the file or choose another `--state` path.
The title and foot collection settings must match when resuming: title-enabled
checkpoints require `--titles`, foot-enabled checkpoints require `--foot`. A mismatched run refuses to start rather than silently
print or erase previously opted-in private titles. There is no cross-machine
history merge; copying a **closed** checkpoint to another machine is a manual
transfer, not synchronization.

## HTML reports and extra detail

`--html PATH` writes a new, self-contained report **on exit** (q, Ctrl+C,
SIGTERM or the duration limit). It includes summary cards, a donut chart,
application bars, excluded time, and an optional title breakdown. There are no
external fonts, scripts, assets or network requests. The page is responsive
and printable. Open the file in your browser after the tracker exits.

Reports are created with owner-only permissions (`0600`). Existing files and
symlinks are never overwritten: use a new filename for each run. Export failure
sets a nonzero exit status. Without `--html`, no HTML is saved, but checkpoints
still persist unless `--no-state` is set. `--json --html` prints the JSON summary
on stdout and the export status on stderr.

A synthetic example is available at **`poc/example-report.html`**. To generate
another without reading the desktop:

```sh
node poc/demo-report.cjs ./example-report.html
```

### LibreWolf: active tab title, not a URL

The backend already supplies the focused **window title**. `--titles` now opts
in to retaining and aggregating that text alongside application totals. A
browser often updates its window title to reflect its active tab, so changing
tabs can produce separate report rows. This only sees the tab displayed by the
focused browser window—not every tab, a tab ID, browsing history or the URL.
Browser privacy settings can limit the exposed title. Identical titles merge;
dynamic titles can split one tab into multiple entries. Percentages use total
tracked time. The title table is in HTML/JSON; the terminal summary stays
application-level. Titles from *all* applications are collected when enabled,
not just browsers, and can expose filenames, projects or private content.
Past runs without `--titles` cannot be expanded retroactively.

### Pi / Claude: title-derived session labels

With `--foot --titles`, an additional **Agent session labels** table correlates
pi/Claude foreground executables with observed foot titles. Both agents can put
an explicit session name in the terminal title, for example `pi --name "Example
work"` or `claude --name "Example work"`. Pi also supports `/name` in an existing
session. These are naming options you use in the agent, not commands the
tracker launches.

The report retains the literal observed title, not a parsed/verified session
name or ID. Status decorations or cwd can appear; identical titles merge and
changing titles split rows. Labels wait for a fresh matching process observation
after title changes. No transcripts, history files, prompts or argv are read.
See [agent-label semantics and compatibility](docs/agent-session-labels.md).
Old running trackers must be stopped/restarted to pick up the new code; their
existing foot/title-enabled checkpoint is resumed without backfilling labels.

### foot: opt-in foreground root executable

`--foot` adds an independent command-time table to terminal, JSON and HTML
reports. Application totals remain foot; the terminal table subdivides those
totals. It resolves the local foreground-job **root executable**, not command
arguments, cwd/projects or the deepest child. `--titles` is independent.

The association spike found a safe path for this machine's standalone foot
windows: a unique owner, a unique PTY master, a matching direct-child session
leader/controlling TTY, and a provable foreground process-group root. Proc
metadata is revalidated to catch PID/exec/job races; native window IDs, titles
and owner PIDs are never changed. Refresh is once per second by default
(`--foot-interval 1000`), independent of title/focus change callbacks.

Shared server/window owners, multiple PTYs, ambiguous pipeline roots, missing
leaders, permissions, unsupported job-control setups, races and scan-budget
exhaustion report **unknown with a reason**, never a guessed process. Background
jobs in other process groups are excluded. Foreground `ssh`/`tmux`/`screen` are
reported as those local executables, not a remote command or active pane.
Shell built-ins remain the shell; wrapper scripts may remain their wrapper
interpreter. Short commands can be missed between polls. When paused, enrichment
scans are skipped and terminal time is not accrued.

For a manual check, run the tracker in one terminal and use another foot window
for shell/editor/build commands. While the tracker's own terminal is focused,
its foreground executable will normally be `node` (the tracker itself).

Use a new `--state` filename when first enabling `--foot`, since existing
application-only history cannot be expanded retroactively. The checkpoint
requires matching collection settings on resume. No terminal or shell settings
are modified. See [the association spike and PoC design](docs/foot-tracking.md)
for the exact proof requirements, bounds, internal context and limitations.

## What to test manually

1. Start the tracker, spend a few seconds in the terminal, then an editor, then
   a browser. Verify the corresponding totals increase.
2. Switch between two windows of the same app: they share one application total.
3. Press **p**, wait, switch windows, then return and press **p** again. Paused
   time is excluded, and tracking resumes for the latest observed focus.
4. With `--foot`, switch shell → editor → shell, and run a foreground build.
   Confirm command rows change even without title changes. A background job
   should not replace the foreground command. Pipelines/shared foot owners may
   correctly report unknown. This is a manual live acceptance check.
5. Press **q**. Application totals plus excluded time should equal elapsed time
   (human-readable output truncates individual values to whole seconds).

For actual empty-focus transitions, the compositor must report no active
window. Switching workspaces does not necessarily produce no focus. No-focus,
IPC error and recovery are also covered by deterministic synthetic tests.

## Accounting and privacy

- Uses a monotonic clock, not wall-clock timestamps.
- Native subscription observes ID/title changes at 100 ms by default. Application
  totals use compositor class (fallback: executable basename). With `--titles`,
  a separate detail table groups time by application and observed window title.
- No focus, startup waiting, IPC outages and manual pause are excluded.
- An IPC error clears the current application until the subscription recovers.
- Focus changes while paused are remembered, but not billed.
- Titles are not inspected or retained by the PoC **unless `--titles` is set**.
  The underlying library necessarily parses compositor responses with titles.
  Opt-in titles are control-stripped and capped at 240 characters, not scrubbed
  of private content. They are HTML-escaped on export to prevent markup injection.
- With `--foot`, PID/start-time/group/TTY metadata and executable symlinks are
  inspected locally. Only executable basenames/unknown reasons and durations
  are persisted, not PIDs or full executable paths. No command lines,
  environment, terminal contents or project paths are read. Opt-in titles may
  still contain private text, independently of terminal attribution.
- Checkpoints now persist application totals, excluded time, a session-start
  timestamp, errors, opted-in title details and opted-in foot executable totals. Use `--no-state`
  to disable that persistence. `--html PATH` separately creates an HTML report.
  Both files can contain private activity history. No full event timeline is
  kept. Stdout redirection is also your choice; scrollback may retain reports.

**This measures foreground-window time, not verified active work.** There is
**no automatic idle or reliable session-lock detection**. A focused application
can accrue time while you are away or locked. Pause manually; don't use this
PoC for billing or attendance. Brief focus changes can be missed between polls,
and attribution boundaries have polling/delivery latency. IPC failure is only
known when detected; the preceding detection interval can still be attributed.
This is window/application-level attribution, optionally enriched with a local
foot foreground root executable—not project or verified browser-URL tracking.

## Tests and local result

```sh
node --test poc/*.test.cjs

# Independent native binding/transport integration tests from the fork:
node x-win/examples/hyprland-subscription-test.cjs x-win/target/debug/x-win.node
```

Tests cover exact accounting, app switches, repeated observations, no focus,
pause/resume, outage/recovery, monotonic time, duration conservation, privacy,
CLI shutdown, invalid options, title opt-in boundaries, HTML escaping, offline
output, private file permissions, and refusal to overwrite reports. They do not
require a compositor. All **42 tests passed** after adding agent label correlation.
New tests cover atomic round trips, concurrent writer rejection, SIGKILL and
restart recovery, title retention/privacy, downtime exclusion, paused recovery,
corrupt data, symlink rejection, and write failure preserving the old checkpoint.

A live 3-second run on the local Hyprland desktop successfully loaded the
freshly built native artifact, attributed approximately three seconds to the
foreground application, and reported zero IPC errors. No live titles or paths
were printed or saved. Interactive application switching and pause/resume are
left for manual testing; accounting transitions have synthetic coverage.
