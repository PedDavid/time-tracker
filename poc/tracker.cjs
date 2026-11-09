#!/usr/bin/env node
'use strict'

const { resolve, join } = require('node:path')
const { homedir } = require('node:os')
const { performance } = require('node:perf_hooks')
const readline = require('node:readline')
const { Accounting, appLabel, windowTitle } = require('./accounting.cjs')
const { writeHtml } = require('./html-report.cjs')
const { Checkpoint } = require('./checkpoint.cjs')

function options(args) {
  const result = {
    native: resolve(__dirname, '../x-win/target/debug/x-win.node'),
    interval: 100,
    refresh: 2,
    duration: null,
    json: false,
    html: null,
    titles: false,
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
  --state PATH          Checkpoint path; resume saved totals automatically
  --flush SECONDS       Checkpoint interval, 0.1–3600 (default 5)
  --no-state            Ephemeral session; disable checkpoint/recovery
Interactive: p = pause/resume, r = report, q = quit. Lock/idle are NOT detected.`)
      return null
    }
    if (flag === '--json') { result.json = true; continue }
    if (flag === '--titles') { result.titles = true; continue }
    if (flag === '--no-state') { result.noState = true; continue }
    if (!['--native', '--html', '--state', '--flush', '--duration', '--interval', '--refresh'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--native' || flag === '--html' || flag === '--state') {
      result[flag.slice(2)] = resolve(value)
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
  const store = config.state ? new Checkpoint(config.state, config.titles) : null
  const ledger = new Accounting(clock(), store?.record?.snapshot)
  const startedAt = store?.record?.startedAt || new Date().toISOString()
  let running = true
  let errors = store?.record?.errors || 0
  let checkpointFresh = Boolean(store?.record)
  let subscription
  let refreshTimer
  let stopTimer
  let flushTimer
  const interactive = process.stdin.isTTY && !config.json
  const wasRaw = process.stdin.isRaw

  function snapshot() {
    return {
      ...ledger.snapshot(clock()), errors, startedAt, titlesEnabled: config.titles,
      measurement: 'foreground-window time, not verified active work',
      idleDetection: false, lockDetection: false, persisted: checkpointFresh,
      checkpointEnabled: Boolean(store),
    }
  }

  function flush(summary = snapshot()) {
    if (!store) return false
    try {
      const { elapsedMs, trackedMs, apps, excluded, details, state } = summary
      store.save({ version: 1, startedAt, savedAt: new Date().toISOString(), titlesEnabled: config.titles, errors,
        snapshot: { elapsedMs, trackedMs, apps, excluded, details, state } })
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
    console.log(`Tracked: ${duration(summary.trackedMs)} | IPC outages: ${errors}`)
    if (summary.excluded.length) console.log(`Excluded: ${summary.excluded.map(([kind, ms]) => `${kind} ${duration(ms)}`).join(', ')}`)
    console.log('p pause/resume · r report · q quit · No idle/lock detection; pause before leaving/locking.')
  }

  function stop() {
    if (!running) return
    running = false
    clearInterval(refreshTimer)
    clearTimeout(stopTimer)
    clearInterval(flushTimer)
    if (subscription !== undefined) {
      try { native.unsubscribeActiveWindow(subscription) } catch { process.exitCode = 1 }
    }
    if (interactive) {
      process.stdin.removeListener('keypress', keypress)
      process.stdin.setRawMode(Boolean(wasRaw))
      process.stdin.pause()
    }
    try { report(true) } finally { store?.close() }
  }

  function keypress(text, key) {
    if ((key?.ctrl && key.name === 'c') || text === 'q') { stop(); return }
    if (text === 'p') { ledger.togglePause(clock()); flush(); report() }
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
    console.log('Counts foreground-window time, not verified active work. No automatic idle/lock detection.')
  }
  // Snapshot avoids attributing startup/load time to the first observed app.
  try {
    const window = native.activeWindow()
    ledger.observe(appLabel(window), clock(), windowTitle(window, config.titles))
  } catch { errors++; ledger.unavailable(clock()) }
  try {
    subscription = native.subscribeActiveWindow((error, window) => {
      if (!running) return // Native callbacks already queued can arrive after unsubscribe.
      if (error) { errors++; ledger.unavailable(clock()); return }
      ledger.observe(appLabel(window), clock(), windowTitle(window, config.titles))
    }, config.interval)
  } catch {
    stop()
    throw new Error('Could not start the native subscription')
  }
  if (store) { flush(); flushTimer = setInterval(flush, config.flush * 1000) }
  if (!config.json) { report(); refreshTimer = setInterval(report, config.refresh * 1000) }
  if (config.duration !== null) stopTimer = setTimeout(stop, config.duration * 1000)
}

try { main() } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
