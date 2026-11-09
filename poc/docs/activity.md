# Read-only Hyprland activity gating

The tracker defaults to **automatic activity gating**. It attributes foreground
window time only while both the input-idle sensor and compositor lock sensor are
available, and neither reports idle/locked. This is still **foreground-window
time, not verified active work**, attendance, or billing evidence.

No desktop configuration, Omarchy plugin, idle inhibitor, lock request, or native
x-win API change is needed. Unsupported environments **exclude activity**, rather
than silently falling back to an old focused window. Explicitly opting out is
possible:

```sh
# Build locally with existing development tools; no downloads/installs.
sh poc/build-activity-helper.sh

node poc/tracker.cjs --idle-timeout 300
# If sensors cannot be supported and foreground-only tracking is intentional:
node poc/tracker.cjs --no-activity
# Alternative helper build location:
node poc/tracker.cjs --activity-helper /absolute/path/to/activity-idle
```

The build needs a C compiler, pkg-config, wayland-scanner, wayland-client headers
and library, and wayland-protocols with **ext-idle-notify v2**. The installed
protocol XML supplies generated code and its license. Generated headers, protocol
C, and binary are placed under `poc/.activity-build/`; do not publish these local
artifacts. No libsystemd/GIO dependency is needed.

## Signals and capability boundary

### Input idle: ext-idle-notify v2

`poc/activity-idle.c` binds `ext_idle_notifier_v1` **version 2** and uses
`get_input_idle_notification`, which ignores idle inhibitors. Version 1's
inhibitor-respecting notification is not an acceptable physical-activity sensor:
a media player could otherwise keep an unattended window attributable forever.
The helper binds a single seat, not keyboards, pointers, touch, or their events.
Missing globals, multiple seats, removal/disconnect, stalled round trips, and
protocol errors make activity unavailable. It never inhibits idle or creates a
surface.

`--idle-timeout` is seconds (1–86400, default **300**). Time before that threshold
is an explicitly allowed grace period, **not evidence of continuous input**.
The helper reports idle when the compositor notification expires. It does not
invent the last-input timestamp, subtract the pre-threshold period, or treat
focus/title changes as activity.

A new protocol notification starts non-idle, with its timeout measured from
creation. This tells us nothing about input before startup/reconnect. Startup is
therefore unavailable until a separate **1 ms input-idle notification** first
idles and then resumes on actual compositor-reported activity; that probe is
immediately destroyed. If the normal timeout expires first, status can become
idle, but never active without a resumed notification. **Move input once after
starting** to establish activity. The probe is 1 ms, not zero: in reviewed
Hyprland `CExtIdleNotification::update(0)`, a zero-timeout notification never
resumes. Only aggregate state/heartbeats are sent to Node, not input events or
per-input timing. Ordinary active time can include reading, watching, synthetic
input, or any input the compositor considers activity; this is not proof of a
physical person working.

### Lock: compositor state, not a shell boolean or logind hint

The lock provider sends only `j/version` and `j/monitors` over Hyprland's Unix
command socket. There is no `hyprctl`, `jq`, shell subprocess, process-tree scan,
or logind polling. Connection, total request timeout (750 ms), response size
(256 KiB), cancellation, JSON, and schema are bounded/validated. The lock query
is attempted every 500 ms, with only one in-flight operation. Socket coordinates
use the tracker's ordinary session connection variables, not `/proc` environments
or process discovery. No fallback to another desktop/session is attempted.

This is a deliberately narrow, reviewed capability: the exact clean upstream
**v0.56.2** build (`efb50993780079460b0cbed1363e2166a2de1d9f`, `dirty: false`).
Other versions/forks require source review before changing the allowlist; a
matching version string alone does not establish this internal diagnostic
schema's semantics.

On this version:

* `src/debug/HyprCtl.cpp::getSolitaryBlockedReason` calls
  `CMonitor::isSolitaryBlocked(true)` rather than returning a cached renderer bit.
* `src/output/Monitor.cpp::isSolitaryBlocked` checks
  `g_pSessionLockManager->isSessionLocked()` and includes `LOCK` even when other
  blockers apply. That manager delegates to the compositor's session-lock
  protocol state, including orphaned client locks.
* The exception is the early return for no active workspace: `WORKSPACE`.
  Absence of `LOCK` there does **not** prove the session unlocked.
* At least one valid readable monitor is required to conclude unlocked. Any
  `LOCK` concludes locked; an empty monitor list, all `WORKSPACE`, absent field,
  unknown reason, or malformed schema is unavailable. An explicitly present
  `null` means zero blockers; an absent field is not equivalent to null.

This follows the stronger compositor source also used by packaged
`/usr/share/omarchy/bin/omarchy-hyprland-session-locked`. Omarchy shell's
`currentlyLocked()` / read-only `lock isLocked` report shell-requested/security
state; they are not used in preference to the compositor. Omarchy's existing
IdleMonitor respects inhibitors for desktop power/lock policy, independently of
this tracker's inhibitor-ignoring measurement policy. Packaged code/config was
only read, never changed.

logind `IdleHint`/`LockedHint` are advisory and are **not** assumed to represent
Hyprland physical inactivity or compositor session locking. In particular,
`loginctl ... self` may identify no desktop from service-launched agents. This
implementation does not depend on discovering a logind session ID.

## Accounting and recovery

`Accounting.setActivity({kind}, now)` accepts `active`, `idle`, `locked`, or
`activity-unavailable`. Manual pause is an independent flag and wins the
excluded-time label. Otherwise the activity gate wins over native focus
availability. A fresh locked signal can exclude time even while the idle helper
is unavailable. Unknown lock or idle status never permits attribution.

State transitions accrue the previous state up to the delivery boundary and
clear the focused app, opted-in title, terminal context, and observer identity.
Native callbacks and foot proc enrichment are ignored while gated. On restoration
`ActivityGate` requests a **new native focus snapshot** and **new foot context**;
it cannot resurrect the previous window/title/executable or agent label. Enabled
subscription callbacks also re-query native focus instead of trusting a queued
pre-restoration payload; this does not trigger per-callback proc scans.
Restoring activity never unpauses a manual pause. Native window IDs, titles and
owner PID values are not changed.

The helper proves liveness with compositor `wl_display.sync` round trips every
approximately 500 ms. Its state has a 1500 ms freshness budget; lock samples have
the same budget. Disconnect/error causes immediate exclusion when detected.
Child stdout is bounded and validated. The helper closes on stdin EOF, parent
death (`PR_SET_PDEATHSIG`), SIGTERM/SIGINT, compositor loss, or registry removal.
Node cancels in-flight IPC, destroys pipes, sends SIGTERM, and uses a 500 ms
SIGKILL fallback for a resistant child. Nothing tries to restart/configure the
desktop. Sensor retry is limited to one helper launch per second and one lock
poll at a time.

Before every native observation, foot scan, manual control, shutdown and
report/checkpoint snapshot, a health check also detects scheduling stalls (>2 seconds) and wall/monotonic
clock divergence (>250 ms, including suspend and clock adjustments). It clears
both signal caches, cancels IPC, and restarts the helper with startup input proof.
The unaccrued interval since the last accounting boundary is conservatively
excluded as `activity-unavailable`, not charged to stale focus. The helper also
checks `CLOCK_BOOTTIME` against `CLOCK_MONOTONIC` and exits on suspend/stalls.
Elapsed time remains accumulated monotonic **recorded runtime**, not wall time:
Linux suspend time need not appear in elapsed totals. Clock adjustment false
positives deliberately exclude time rather than guess activity.

Checkpoints retain versions **1/2/3** and existing title/foot opt-in validation.
New snapshots save independently validated `manualPaused` and `activity` fields;
records save `activityDetection` policy metadata (enabled, timeout, reviewed
sources/scope, history coverage). A restart restores totals/manual pause but
**never** restores a current activity signal, focus, title, or terminal context;
downtime is not counted. Legacy files without the new fields still load.
Switching detection policy is allowed without changing title/foot collection.
`activityDetection.historyComplete` becomes false after legacy history or any
`--no-activity` run and stays false: enabling gating now does not make old totals
idle/lock-filtered. This flag describes policy coverage, not sensor perfection.

JSON `idleDetection`/`lockDetection` flags mean **enabled for this run**, not that
a sensor is currently connected or that all historical totals were gated. Check
`activityDetection.status`, `.reason`, and `.historyComplete` as well. Disabled
runs explicitly report both detection flags false. Application totals plus all
excluded buckets still equal recorded elapsed time.

## Tests and actual validation

```sh
node --test poc/activity.test.cjs poc/activity-native.test.cjs
node --test poc/*.test.cjs
```

Pure JS tests inject signals, clocks, transport, helper processes and scheduling.
They cover active/idle/active, lock/unlock, independent pause, stale terminal/title
clearing, startup/unsupported/disconnect, malformed/oversized/timed-out Unix IPC,
expiry, suspend gaps, cancellation, helper cleanup, metadata validation and old
checkpoint versions. CLI tests use synthetic focus and a missing helper, proving
fail-closed startup and explicit opt-out with checkpoint recovery.

Optional C transport tests compile a **synthetic Wayland server** plus the real
helper into a temporary directory. They test input-proof startup, active → idle
→ active, absent seat, notifier v1, multiple seats, invalid resumed/duplicate-idled
sequences, disconnect and cleanup without
a real compositor. They skip when existing client/server development tools are
missing; pure JS tests need neither a compositor nor a compiled helper.

On this machine the helper built against installed wayland-client 1.26.0 and
protocol XML. A sanitized direct read-only query validated the clean reviewed
Hyprland build and one unlocked readable monitor. A 2.2-second read-only helper
probe returned six aggregate messages, observed startup-unavailable then active
through naturally occurring input, and exited cleanly on SIGTERM. A separate 1.2-second live tracker run (no state, no title/foot opt-ins) excluded
startup, then tracked naturally occurring activity with zero IPC errors; only
sanitized aggregate counts/status were printed. No input, idle, lock, suspend, or
unlock was induced; no desktop config was changed.
**Real lock/orphaned-lock transitions and real suspend have not been exercised**:
those guarantees rely on reviewed compositor semantics plus mocked transitions,
not a forced lock of the user's desktop.

## Remaining limitations

* Lock polling and idle delivery have latency (nominally up to a polling interval,
  plus IPC/scheduling delay). Detection cannot retroactively identify the exact
  instant of a lock or outage; a preceding detection interval can still count.
  This is reliable fail-closed gating when signals are known, not a zero-latency
  security boundary or a guarantee of perfect activity measurement.
* The source covers compositor **ext-session-lock state**, including orphaned
  locks—not arbitrary lock-looking windows, screen savers, another seat/session,
  or a malicious/patched compositor. Future Hyprland changes fail closed until
  reviewed. No claim of general Wayland lock detection is made.
* A lock shorter than the polling interval may be missed. Physical input vs.
  synthesized activity cannot be distinguished through this protocol.
* Pre-threshold idle grace counts as foreground time. Startup/reconnection can
  intentionally exclude time until the next input. No-focus/title heuristics
  fill those gaps.
* Sensor errors do not cause keylogging, terminal-content capture, command-line
  reads, process environment reads or per-poll process-tree scans. Only the
  separately opted-in existing foot enrichment reads bounded proc metadata,
  and only when activity is active. Existing title privacy policy is unchanged.
