#!/usr/bin/env node
'use strict'

const { resolve, join } = require('node:path')
const { homedir } = require('node:os')
const { performance } = require('node:perf_hooks')
const readline = require('node:readline')
const { Accounting } = require('./accounting.cjs')
const { FootObserver } = require('./foot-observer.cjs')
const { writeHtml } = require('./html-report.cjs')
const { Checkpoint } = require('./checkpoint.cjs')
const { ActivityProvider, ActivityGate, activityMetadata } = require('./activity.cjs')
const { HumanTimeline } = require('./timeline-client.cjs')

function options(args) {
  const result = {
    native: resolve(__dirname, '../x-win/target/debug/x-win.node'),
    interval: 100,
    refresh: 2,
    duration: null,
    json: false,
    html: null,
    titles: false,
    foot: false,
    kitty: false,
    activity: true,
    'idle-timeout': 300,
    'activity-helper': resolve(__dirname, '.activity-build/activity-idle'),
    'foot-interval': 1000,
    state: join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'focus-tracker', 'session.json'),
    flush: 5,
  }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--help' || flag === '-h') {
      console.log(`Local focus-time PoC (automatic local checkpoints; --no-state to disable)
Usage: node poc/tracker.cjs [options]
  --duration SECONDS    Stop automatically (otherwise Ctrl+C or q)
  --interval MS         Native polling interval, 50–60000 (default 100)
  --refresh SECONDS     Summary frequency (default 2)
  --native PATH         Explicit freshly built native addon
  --json                Print only a final JSON summary
  --html PATH           Save a private standalone HTML report on exit (new file only)
  --titles              Opt in to window-title collection (may contain private data)
  --foot                Opt in to local foreground-executable tracking for foot
  --terminals           Same, for every supported terminal: foot and kitty (kitty uses its
                        remote-control socket, $KITTY_LISTEN_ON). Implies --foot's data.
  --foot-interval MS    Foot context refresh, 500–60000 (default 1000)
  --idle-timeout SEC    Exclude input-idle time after 1–86400 seconds (default 300)
  --activity-helper PATH  Locally built read-only Wayland idle helper
  --no-activity         Explicitly disable automatic idle/lock gating (unsafe away)
  --state PATH          Checkpoint path; resume saved totals automatically
  --flush SECONDS       Checkpoint interval, 0.1–3600 (default 5)
  --no-state            Ephemeral session; disable checkpoint/recovery
  --timeline            Opt in to interval history for the local timeline app
  --timeline-socket PATH  Collector socket (also enables --timeline)
Interactive: p = pause/resume, r = report, q = quit. See poc/docs/activity.md for capabilities.`)
      return null
    }
    if (flag === '--json') { result.json = true; continue }
    if (flag === '--titles') { result.titles = true; continue }
    if (flag === '--foot') { result.foot = true; continue }
    if (flag === '--terminals') { result.foot = true; result.kitty = true; continue }
    if (flag === '--timeline') { result.timeline = true; continue }
    if (flag === '--no-state') { result.noState = true; continue }
    if (flag === '--no-activity') { result.activity = false; continue }
    if (!['--native', '--html', '--state', '--flush', '--duration', '--interval', '--refresh', '--foot-interval', '--idle-timeout', '--activity-helper', '--timeline-socket'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--native' || flag === '--html' || flag === '--state' || flag === '--activity-helper' || flag === '--timeline-socket') {
      result[flag.slice(2)] = resolve(value)
      if (flag === '--timeline-socket') result.timeline = true
      if (flag === '--state') result.customState = true
      continue
    }
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0 || number > 86400) throw new Error(`Invalid value for ${flag}`)
    result[flag.slice(2)] = number
  }
  if (!Number.isInteger(result.interval) || result.interval < 50 || result.interval > 60000) {
    throw new Error('--interval must be an integer between 50 and 60000 ms')
  }
  if (!Number.isInteger(result['foot-interval']) || result['foot-interval'] < 500 || result['foot-interval'] > 60000) throw new Error('--foot-interval must be an integer between 500 and 60000 ms')
  if (result['idle-timeout'] < 1) throw new Error('--idle-timeout must be between 1 and 86400 seconds')
  if (result.refresh < 0.1) throw new Error('--refresh must be at least 0.1 seconds')
  if (result.flush < 0.1 || result.flush > 3600) throw new Error('--flush must be between 0.1 and 3600 seconds')
  if (result.noState && result.customState) throw new Error('Use --state or --no-state, not both')
  result.state = result.noState ? null : resolve(result.state)
  if (result.state && [result.state, `${result.state}.lock`].includes(result.html)) throw new Error('HTML and checkpoint paths must differ')
  return result
}

function duration(ms) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

function main() {
  const config = options(process.argv.slice(2))
  if (!config) return
  let native
  try { native = require(config.native) } catch {
    throw new Error('Cannot load native addon. Build the fork and copy its .so to target/debug/x-win.node; see poc/README.md.')
  }
  const clock = () => performance.now()
  const store = config.state ? new Checkpoint(config.state, config.titles, config.foot) : null
  const initialTime = clock()
  const timeline = config.timeline ? new HumanTimeline({ socket: config['timeline-socket'], now: initialTime }) : null
  const ledger = new Accounting(initialTime, store?.record?.snapshot, timeline ? (...args) => timeline.record(...args) : null)
  const startedAt = store?.record?.startedAt || new Date().toISOString()
  let running = true
  let errors = store?.record?.errors || 0
  let checkpointFresh = Boolean(store?.record)
  let subscription
  let refreshTimer
  let stopTimer
  let flushTimer
  let footTimer
  let footSoon
  let timelineTimer
  const observer = new FootObserver({ native, ledger, clock, titles: config.titles, enabled: config.foot, kitty: config.kitty })
  const gate = new ActivityGate({ native, ledger, observer, clock, onError: () => { errors++ } })
  const activity = config.activity ? new ActivityProvider({ idleTimeoutMs: Math.round(config['idle-timeout'] * 1000), helper: config['activity-helper'], clock }) : null
  if (activity) ledger.setActivity({ kind: 'activity-unavailable' }, clock())
  const activityPolicy = activityMetadata(config.activity, Math.round(config['idle-timeout'] * 1000))
  if (store?.record && store.record.activityDetection?.historyComplete !== true) activityPolicy.historyComplete = false
  const pollFoot = () => {
    activity?.checkHealth()
    if (running && ledger.activity === 'active' && !observer.poll()) errors++
  }
  const interactive = process.stdin.isTTY && !config.json
  const wasRaw = process.stdin.isRaw

  function snapshot() {
    activity?.checkHealth()
    return {
      ...ledger.snapshot(clock()), errors, startedAt, titlesEnabled: config.titles, footEnabled: config.foot,
      measurement: 'foreground-window time, not verified active work',
      idleDetection: config.activity, lockDetection: config.activity,
      activityDetection: { ...activityPolicy, status: ledger.activity, reason: activity?.reason || 'explicitly-disabled' },
      persisted: checkpointFresh,
      checkpointEnabled: Boolean(store),
    }
  }

  function flush(summary = snapshot()) {
    if (!store) return false
    try {
      const { elapsedMs, trackedMs, apps, excluded, details, terminals, agentLabels, state, manualPaused, activity: activityState } = summary
      store.save({ version: config.foot ? (config.titles ? 3 : 2) : 1, startedAt, savedAt: new Date().toISOString(), titlesEnabled: config.titles, footEnabled: config.foot, errors,
        activityDetection: activityPolicy,
        snapshot: { elapsedMs, trackedMs, apps, excluded, details, terminals, agentLabels, state, manualPaused, activity: activityState } })
      checkpointFresh = true
      return true
    } catch (error) {
      checkpointFresh = false
      console.error(`Checkpoint failed (${error.code || 'write/validation error'}). Tracking continues, but recent time is not guaranteed durable.`)
      return false
    }
  }

  function report(final = false) {
    const summary = snapshot()
    if (final && store) {
      summary.persisted = flush(summary)
      if (!summary.persisted) process.exitCode = 1
    }
    if (final && config.html) {
      try {
        writeHtml(config.html, summary)
        summary.persisted = true
        console.error(`HTML report saved: ${config.html}`)
      } catch (error) {
        console.error(`HTML export failed (${error.code || 'unknown error'}). Existing files are never overwritten; choose a new --html path.`)
        process.exitCode = 1
      }
    }
    if (config.json) {
      if (final) console.log(JSON.stringify(summary, null, 2))
      return
    }
    if (interactive && !final) process.stdout.write('\x1b[2J\x1b[H')
    console.log(`\n${final ? 'Final' : 'Local'} focus-time report — elapsed ${duration(summary.elapsedMs)}`)
    const state = summary.state
    console.log(`State: ${state.kind}${state.app ? ` — ${state.app}` : ''}`)
    console.log('Application'.padEnd(42) + 'Time'.padEnd(12) + 'Share of tracked')
    for (const [app, ms] of summary.apps) {
      console.log(app.slice(0, 40).padEnd(42) + duration(ms).padEnd(12) + `${(ms / summary.trackedMs * 100).toFixed(1)}%`)
    }
    if (config.foot) {
      console.log('\nfoot foreground executables (separate from application totals):')
      for (const row of summary.terminals) console.log(`${row.executable || `unknown (${row.reason})`}`.padEnd(42) + duration(row.ms))
      if (config.titles && summary.agentLabels.length) {
        console.log('\nAgent session labels (window-title derived, not verified IDs):')
        for (const row of summary.agentLabels) console.log(`${row.executable} — ${row.label}`.padEnd(64) + `  ${duration(row.ms)}`)
      }
    }
    console.log(`Tracked: ${duration(summary.trackedMs)} | IPC outages: ${errors}`)
    if (summary.excluded.length) console.log(`Excluded: ${summary.excluded.map(([kind, ms]) => `${kind} ${duration(ms)}`).join(', ')}`)
    console.log(`p pause/resume · r report · q quit · Activity gating ${config.activity ? `ON (${summary.activityDetection.status})` : 'OFF; pause before leaving/locking'}.`)
  }

  function stop() {
    if (!running) return
    // A shutdown/control event can be the first callback after suspend or a
    // stall. Apply its health transition before disabling the gate listener.
    activity?.checkHealth()
    running = false
    clearInterval(refreshTimer)
    clearTimeout(stopTimer)
    clearInterval(flushTimer)
    clearInterval(footTimer)
    clearTimeout(footSoon)
    clearInterval(timelineTimer)
    activity?.close()
    if (subscription !== undefined) {
      try { native.unsubscribeActiveWindow(subscription) } catch { process.exitCode = 1 }
    }
    if (interactive) {
      process.stdin.removeListener('keypress', keypress)
      process.stdin.setRawMode(Boolean(wasRaw))
      process.stdin.pause()
    }
    try { report(true) } finally { store?.close(); void timeline?.flush() }
  }

  function keypress(text, key) {
    activity?.checkHealth() // Never accrue a stale gap before pause/resume.
    if ((key?.ctrl && key.name === 'c') || text === 'q') { stop(); return }
    if (text === 'p') { ledger.togglePause(clock()); if (config.foot) pollFoot(); flush(); report() }
    if (text === 'r') report()
  }

  // Synchronous best effort on ordinary Node exit/uncaught exceptions too.
  // SIGKILL/power loss cannot run this hook: recovery uses the last checkpoint.
  process.once('exit', () => { if (running) stop() })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  if (interactive) {
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('keypress', keypress)
  }
  if (!config.json) {
    console.log(`Local-only PoC: ${config.titles ? 'window-title collection ON (private data)' : 'window-title collection off'}; paths and command arguments are not retained.`)
    console.log(store ? `Private checkpoints every ${config.flush}s: ${config.state}${store.record ? ' (resuming saved totals)' : ''}` : 'Checkpointing disabled: session is in memory only.')
    if (config.html) console.log('HTML export enabled: a new report file will be saved on exit.')
    if (config.foot) console.log(`foot foreground tracking ON: proc metadata refresh every ${config['foot-interval']}ms; ambiguous associations report unknown.`)
    console.log(`Counts foreground-window time, not verified active work. Automatic activity gating ${config.activity ? 'ON; unavailable signals exclude time. Move input once to establish activity.' : 'OFF; pause before leaving/locking.'}`)
    if (config.activity) console.log('Requires built Wayland helper and reviewed Hyprland 0.56.2 lock capability; see poc/docs/activity.md.')
  }
  // Snapshot avoids attributing startup/load time to the first observed app.
  if (activity) activity.start((signal) => { if (running) gate.signal(signal) })
  else gate.refresh()
  try {
    subscription = native.subscribeActiveWindow((error, window) => {
      if (!running) return // Native callbacks already queued can arrive after unsubscribe.
      activity?.checkHealth()
      if (ledger.activity !== 'active') return
      if (error) { errors++; observer.fail(); return }
      if (activity) {
        // Queued subscription payloads may predate gate restoration. Never let
        // one replace the newly established focus/context with cached data.
        try { window = native.activeWindow() } catch { errors++; observer.fail(); return }
        activity.checkHealth()
        if (ledger.activity !== 'active') return
      }
      if (observer.observe(window) && config.foot && !footSoon) {
        footSoon = setTimeout(() => { footSoon = null; pollFoot() }, 0)
      }
    }, config.interval)
  } catch {
    stop()
    throw new Error('Could not start the native subscription')
  }
  if (config.foot) footTimer = setInterval(pollFoot, config['foot-interval'])
  if (store) { flush(); flushTimer = setInterval(flush, config.flush * 1000) }
  if (timeline) timelineTimer = setInterval(() => { snapshot(); void timeline.flush() }, 5000)
  if (!config.json) { report(); refreshTimer = setInterval(report, config.refresh * 1000) }
  if (config.duration !== null) stopTimer = setTimeout(stop, config.duration * 1000)
}

try { main() } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
