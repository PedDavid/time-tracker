# Read-only export while tracking continues

```sh
# No native addon, compositor, flock command or running tracker is needed.
# Pick a NEW HTML filename. Nothing is automatically opened or published.
node poc/export-report.cjs --state ./state/session.json --html ./snapshot.html

# Only when the saved checkpoint collected these opted-in details:
node poc/export-report.cjs --state ./state/foot.json --html ./details.html --titles --foot

# Keep THIS SAME file updated while the exporter is running:
node poc/export-report.cjs --state ./state/foot.json --html ./live.html --titles --foot --watch
```

Without `--state`, the exporter uses
`$XDG_STATE_HOME/focus-tracker/session.json`, falling back to
`~/.local/state/focus-tracker/session.json`. The checkpoint must already exist.
`--html NEWFILE` is required. `--help` lists the supported options; unknown
options fail before any reads or writes.

## Keep the file updated: `--watch`

Without `--watch`, export is one-shot: it writes a static snapshot and exits.
With `--watch`, the exporter stays running and polls the checkpoint every **5
seconds**. When its rendered contents change, it atomically replaces the **same
HTML file**. Open that file in your browser and press **Ctrl+R** for newer totals.
There is no automatic browser refresh, JavaScript, server, or browser launch.
`--watch-interval SEC` changes the poll interval (0.1–3600 seconds, requires
`--watch`). Polling faster cannot make the writer save faster; checkpoint delay
and export polling delay can add together.

Watch mode must start with a **new filename**, just like one-shot export. It
only replaces reports created by that running exporter, never adopts an
existing file. If its output is removed, replaced, edited, linked, or made
public, it stops rather than clobbering it. It also stops on invalid checkpoints,
privacy-policy changes, or I/O errors, retaining the last successful report when
possible. Errors go to stderr and give a nonzero exit status. **Ctrl+C** or
SIGTERM stops watching cleanly; the last report remains. Restart with a new
output filename—an earlier process's report is not silently claimed.

## Saved snapshot, not a live query

The HTML includes the **checkpoint as-of / saved-at timestamp** in UTC and a
freshness warning. The tracker normally checkpoints every five seconds, so an
export is typically about five seconds behind, plus scheduling and I/O delay.
This is not a freshness guarantee: stopped trackers, failed saves or a different
flush interval can leave a much older checkpoint. For older checkpoints without
`savedAt`, the report explicitly labels its fallback as the opened file's
modification time, not a known save timestamp. An invalid supplied timestamp is
rejected rather than guessed.

The exporter renders exactly the saved application, title, foot, agent-label and
excluded-time totals. It does not create an accounting clock, restore current
focus, count downtime, or add time between the checkpoint and export. Existing
charts and detail sections remain available. Validated `activityDetection`
policy is combined with the saved snapshot's `activity` state, not current
sensor state. Enabled/disabled gating and incomplete historical policy coverage
are described in the HTML; a newly enabled policy cannot make older totals
idle/lock-filtered. Legacy `idleDetection`, `lockDetection` and `detection`
metadata is also preserved and displayed as escaped saved metadata. No
capabilities or current idle/lock status are inferred from the exporting machine.
A checkpoint without recorded activity policy is labelled as such.

## Consent and privacy

Both flags must **exactly match** the checkpoint's collection policy, as when
resuming tracking. A title-enabled checkpoint requires explicit `--titles`, even
if its title table happens to be empty. A foot-enabled checkpoint requires
explicit `--foot`. Conversely, specifying a flag for a checkpoint that did not
collect that data is rejected. This deliberately does not silently strip data or
pretend previously uncollected details exist. Policy mismatch creates no HTML.
Supported checkpoint schemas are 1, 2 and 3, using the shared checkpoint
validator; older checkpoints are not upgraded or backfilled.

Titles and title-derived agent labels can contain private names, paths or task
text. They remain opt-in and are HTML-escaped. Even an application-only report is
private activity history. Reports are self-contained, with no external assets or
network requests; export never opens a browser or publishes a file. Diagnostics
do not print checkpoint contents, private labels or supplied paths. There is no
transcript, history, browser, proc, compositor or native-addon access.

## Filesystem behavior

The exporter does **not** construct the writer `Checkpoint`, acquire its lock,
open/create a lockfile, chmod anything, create directories, or modify the
checkpoint. Watch mode creates private temporary HTML files and renames them
over only its own report; no checkpoint or writer lock is renamed/deleted. It works while another process holds the writer's
exclusive flock. It also works with no `flock` executable installed.

It opens the checkpoint read-only with `O_NOFOLLOW` (and `O_NONBLOCK` so a FIFO
cannot hang the open), then validates the opened fd as a regular file owned by
the current user with no group/other permissions. It rejects public permissions
rather than repairing them. Reads are bounded to **16 MiB**, including if a file
grows while being read. Missing, malformed, oversized, incompatible and unsafe
inputs produce errors without creating a report.

The fd pins **one inode**. If the tracker atomically renames a new checkpoint
while export is reading, export sees the previous complete inode or the next
complete inode, never a mix from reopening the pathname. No retry or writer
coordination is necessary. Evident in-place size/mtime changes are rejected;
consistent reads rely on the tracker's normal atomic-rename writer contract,
not on supporting arbitrary in-place editors.

Both modes initially create a new file exclusively (owner-only `0600`, subject
to a stricter umask). Pre-existing files and final-component symlinks, including
dangling symlinks, are never overwritten or followed. Subsequent watch updates
use private same-directory temporaries and atomic rename, checking the owned
output's inode, timestamps, size, ownership, permissions and link count before
replacement. Unchanged rendered snapshots do not rewrite the file. Checkpoint and
lock output paths are explicitly rejected, including aliases through existing
parent-directory symlinks. Parent directories must already exist and are not
changed. As with the tracker, use trusted local directories and normal POSIX
filesystem semantics; this is not an adversarial directory sandbox. Opening a
checkpoint can update its filesystem access time; its bytes, mode and
modification time are not changed. A disk/write failure can leave a partial new
HTML file; the exporter does not delete it or retry over it. Choose a fresh
filename for a retry.

## Synthetic verification

```sh
node --test poc/export-report.test.cjs poc/report-watch.test.cjs
node --test poc/*.test.cjs
```

The export tests use only temporary synthetic checkpoints. They cover exact
saved totals, title/foot consent, schemas 1/2/3, escaped labels/metadata, fd-pinned
rename races, successive atomic snapshots while a child holds a writer flock,
unchanged checkpoint/lock bytes and metadata, bounded reads, ownership and
permissions checks, corrupt/missing/oversized/symlink/nonregular inputs, output
collisions and aliases, default XDG lookup, and no native/live-query dependencies.
Watch tests also cover atomic updates, unchanged snapshots, private permissions,
external edits/replacements/symlinks/links, failed writes and cleanup, ownership
rechecks before publishing, a live writer lock, changed consent, and shutdown.
The writer-lock integration test (like existing checkpoint tests) needs the
system `flock` command to start its synthetic writer, and the FIFO rejection test
uses `mkfifo` to create its fixture. The exporter itself needs neither command.
