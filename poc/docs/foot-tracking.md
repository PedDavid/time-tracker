# foot foreground attribution: association spike and PoC design

## Scope and evidence

This is the separate terminal-attribution milestone from PRD 003, implemented
**only in the PoC**. No changes to x-win's WindowInfo, native bindings, owner
PID, window identity or titles. No shell/foot/desktop configuration changes,
terminal remote control, or controlling-TTY opens are required.

The read-only local spike on foot **1.28.0** and Hyprland **0.56.2** found:

- Two foot windows with distinct compositor owner PIDs.
- Each owner held exactly one PTY master with `tty-index` in its fdinfo.
- Each had a direct child session leader whose `/proc/PID/stat` controlling
  device matched the corresponding `/dev/pts/N` device number.
- The anchor's `tpgid` identified a foreground process group with one root.
- Resolving that root's executable basename identified the programs actually
  running in the two terminals, without reading titles/argv/environment/output.

Initial standalone live resolution measured about **7–13 ms** per owner on this
machine. This is a short sample, not a worst-case guarantee. No live PIDs,
paths, window titles or command arguments are fixtures in this repository.

## Proof requirements (fail closed)

For each current foot window:

1. Exactly one compositor window has its owner PID. The actual owner executable
   must resolve to `foot`, not merely have a matching app class.
2. The owner must have exactly one distinct PTY master `tty-index`. Duplicated
   FDs for one master are fine. Multiple PTYs or missing metadata are unknown.
3. Exactly one direct child of foot must be a session leader and have the
   matching controlling-TTY device. Device metadata is obtained with stat,
   **not** by opening the slave TTY or issuing job-control ioctls.
4. Read that child's `tpgid`. Only after this association, enumerate `/proc`
   stat entries matching foreground PGID, session ID and controlling TTY.
   Background groups and other terminals never qualify just by ancestry.
5. The group must have exactly one root (a member whose parent is outside the
   group), and that root must be the live PGID leader. It must be the anchor
   itself (interactive shell) or a direct job child of the anchor.
6. Resolve the root executable symlink. Recheck owner/anchor/root identity,
   start time, process-group and TTY metadata, executable and the owner's PTY
   set before returning. The observer also rechecks compositor focus after
   scanning, discarding results if the window/owner changed.

No process tree is searched for a likely/deepest child. A foreground build tool
remains the root tool, not whichever compiler/helper is deepest. There is no
PID-only metadata cache. All checks are best-effort snapshots, not an atomic
kernel/compositor transaction; a command can change immediately after a check.

## PoC-local opt-in shape

Flag: `--foot`. Refresh interval: `--foot-interval 1000` milliseconds, minimum
500 ms, independent of the native subscription's ID/title comparison.

Internal observation:

```js
{ status: 'resolved', executable: 'nvim', foregroundPid: 300,
  source: 'proc-pty-foreground-root' }
// or:
{ status: 'unknown', reason: 'multiple-foreground-roots' }
```

This is not a new public native API. A reusable x-win terminal-context API
remains a separate design/review decision. The existing owner's PID is never
replaced by foregroundPid. PIDs and full executable paths are **not persisted**
by the PoC. Aggregate snapshot/checkpoint/report rows are separate from the
application and title dimensions:

```js
terminals: [
  { app: 'foot', executable: 'nvim', reason: null, ms: 12000 },
  { app: 'foot', executable: null, reason: 'multiple-ptys', ms: 3000 }
]
```

Application totals still say foot. Terminal rows subdivide only observed foot
time (including unknowns); they must not be added to the application totals.
Window title collection is independent and remains off without `--titles`.
A newly focused foot window starts as pending/unknown until resolved; the
previous window's command is never carried over. No-focus/errors clear context.
Pause excludes terminal time and skips background scans; resume refreshes it.

Foot-enabled checkpoints use schema **2**, or schema **3** when titles are also
enabled to preserve the new agent-label dimension (see
[agent session labels](agent-session-labels.md)). Existing schema-2 foot/title
histories can be upgraded without backfilling labels. Application-only
checkpoints retain version 1. Older tracker versions reject unfamiliar schemas
rather than silently dropping enriched history. The foot
setting must match on resume, like the title setting; use a fresh `--state`
path when opting in, so old unobserved time is not retroactively presented as
command-level tracking. Restoring totals never restores live foreground context.

## Bounds and privacy

Proc work occurs only with `--foot`, while unpaused and focused on foot.
It runs approximately once a second, plus initial/new-focus refreshes, not on
every 100 ms title update. Each scan limits owner FDs to 256, direct children
to 64, process IDs to 4096, directory entries to 8192 and individual proc reads
to 16 KiB. A **50 ms soft budget**, checked between operations, returns unknown
on exhaustion. Ordinary proc filesystem calls are synchronous and do not have
independent hard I/O deadlines. The native IPC calls have their existing limits.

Only stat, executable symlinks, direct-child PID lists, fdinfo and PTY device
metadata are inspected. No cmdline, environment, cwd, project lookup, terminal
output/content, network requests or per-poll subprocesses. Opted-in executable
basenames are persisted in the existing private checkpoint and optional HTML.
As with application names, these can reveal activity. `--no-state` disables
checkpoint persistence; `--html` independently requests report persistence.

## Honest limitations

- Shared foot/server owner across windows: **unknown**, even if the owner has
  a plausible descendant. Single-window owners with several PTYs also unknown.
- Custom app IDs work if x-win resolves executable basename `foot`. If both
  that metadata and the standard class are unavailable, it is not classified
  as foot; arbitrary terminal emulators are not probed.
- Pipelines with multiple foreground roots, missing/dead group leaders,
  reparenting, nested/detached job-control setups, containers, restricted proc,
  permissions and observed races: unknown. No arbitrary member is selected.
- A wrapper shell remains the root executable while waiting for descendants.
  This is top-level foreground-job attribution, not a deepest-command tracker.
- `tmux`/`screen`: report the local foreground client executable only, never
  guess an active pane from a server tree. `ssh`: report SSH locally, not the
  remote program. Shell built-ins remain the shell.
- Short commands between polls can be missed. Changes are attributed at
  observation/delivery time, not exact exec timestamps.
- Foot attribution does not determine activity itself. The tracker's separate
  [activity gate](activity.md) excludes idle/lock/unavailable periods and refreshes
  foot context on return. With `--no-activity`, pause manually when leaving/locking.
- Group reparenting/fork/exec/focus changes can race with a scan despite the
  revalidation. Unknown outcomes are expected and shown with reasons.

## Validation

Run `node --test poc/*.test.cjs`. Synthetic coverage includes shell → editor →
shell with unchanged title, build/helper roots, background exclusion, shared
owners, multiple/duplicated PTYs, cross-TTY rejection, large PTY minor numbers,
pipeline ordering, SSH/multiplexer handling, exit/permissions/PID reuse/exec
races, scan limits/deadline, focus changes mid-scan, pause/disabled behavior,
checkpoint policy/validation and HTML escaping. A CLI fixture emits no native
title/focus callbacks and verifies independent polling and checkpoint/export.

Live association was checked against existing terminals without launching or
manipulating desktop windows. Synthetic tests prove the transition logic; a
full live shell/editor/build/background-job/pipeline acceptance run remains a
manual follow-up. No support for other terminal emulators is claimed.

## kitty (via remote control)

`--terminals` (which implies the `--foot` data) also resolves kitty windows; plain
`--foot` never contacts kitty. kitty runs every window in one process, so
the PTY proof above cannot apply. The tracker instead asks kitty's own
remote-control socket (`kitten @ --to $KITTY_LISTEN_ON ls`) which tab/window is
active in the focused OS window (matched by its `wm_class` against the compositor
class) and which process ids are in its foreground group, then applies the same
single-root and `/proc` executable checks as foot, including start-time/executable
revalidation. Titles, cwd, cmdlines and env in kitty's reply are never read; only
a basename is stored.

Requires `allow_remote_control` and a `listen_on` socket in your kitty config
(nothing is configured by the tracker); the tracker reads the address from
`KITTY_LISTEN_ON`, which kitty sets in its windows. If it is missing or kitty does
not answer within 750 ms, the window is recorded as unknown, never guessed. A
subprocess is spawned per poll (about 30 ms, default every second). Executables with a
version-number basename (e.g. `.../claude/versions/2.1.319`) resolve to the
kernel process name (`claude`) for foot and kitty alike.
