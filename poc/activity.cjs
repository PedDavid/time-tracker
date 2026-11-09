'use strict'
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')
const hyprland = require('./activity-hyprland.cjs')

function activityMetadata(enabled, idleTimeoutMs) {
  return { enabled, idleTimeoutMs, historyComplete: enabled, idleSource: 'ext-idle-notify-v2-input', lockSource: 'hyprland-monitors-solitary', lockScope: 'hyprland-0.56.2-polled' }
}

// All dependencies can be mocked; no desktop is needed for unit tests.
class ActivityProvider {
  constructor({ idleTimeoutMs = 300000, helper = join(__dirname, '.activity-build/activity-idle'),
    clock = () => performance.now(), wall = () => Date.now(), spawnHelper = spawn,
    request = hyprland.request, path = () => hyprland.socketPath(),
    interval = setInterval, clear = clearInterval } = {}) {
    Object.assign(this, { idleTimeoutMs, helper, clock, wall, spawnHelper, request, path, interval, clear })
    this.kind = 'activity-unavailable'
    this.idle = null
    this.lock = null
    this.idleAt = this.lockAt = -Infinity
    this.closed = false
    this.child = null
    this.children = new Set()
    this.verified = false
    this.pending = false
    this.lastTick = clock()
    this.lastWall = wall()
    this.reason = 'startup'
  }

  start(listener) {
    this.listener = listener
    listener({ kind: this.kind, reason: this.reason })
    this.timer = this.interval(() => this.tick(), 250)
    this.tick()
    return this
  }

  status() {
    if (this.lock === 'locked' && this.clock() - this.lockAt <= 1500) return 'locked'
    if (!this.lock || this.clock() - this.lockAt > 1500 || !this.idle || this.clock() - this.idleAt > 1500) return 'activity-unavailable'
    return this.idle
  }

  publish(reason = 'signals', gap = false) {
    if (this.closed) return
    const kind = this.status()
    const newFailure = kind === 'activity-unavailable' && !['signals', 'signal-expired'].includes(reason) && reason !== this.reason
    if (kind !== this.kind || gap || newFailure) {
      this.kind = kind
      this.reason = reason
      this.listener?.({ kind, reason, gap })
    }
  }

  // Call before every focus observation AND snapshot, not just the timer. This
  // catches a queued native callback arriving first after suspend/event-loop stall.
  checkHealth() {
    if (this.closed) return false
    const now = this.clock(), wall = this.wall()
    const gap = now - this.lastTick > 2000 || Math.abs((wall - this.lastWall) - (now - this.lastTick)) > 250
    this.lastTick = now; this.lastWall = wall
    if (gap) {
      this.idle = this.lock = null
      this.verified = false
      this.abort?.abort()
      this.retireHelper()
    }
    this.publish(gap ? 'suspend-or-stall' : 'signal-expired', gap)
    return this.kind === 'active'
  }

  tick() {
    if (this.closed) return
    this.checkHealth()
    if (this.child && this.clock() - this.launchAt > 1750 && this.clock() - this.idleAt > 1500) {
      this.retireHelper()
      this.publish('helper-expired')
    }
    if (!this.child && this.clock() - (this.launchAt ?? -Infinity) >= 1000) this.launchHelper()
    if (!this.pending && this.clock() - (this.pollAt ?? -Infinity) >= 500) this.pollLock()
  }

  retireHelper() {
    const child = this.child
    this.child = null
    this.idle = null
    this.idleAt = -Infinity
    if (!child) return
    child.stdin?.destroy()
    child.kill('SIGTERM')
    // Bounded fallback for a wedged helper. Keep this timer referenced so clean
    // shutdown cannot exit and leave a resistant mock/child behind.
    child.activityKillTimer = setTimeout(() => { child.kill('SIGKILL') }, 500)
  }

  launchHelper() {
    this.launchAt = this.clock()
    let child
    try { child = this.spawnHelper(this.helper, [String(this.idleTimeoutMs)], { stdio: ['pipe', 'pipe', 'ignore'] }) }
    catch { this.publish('helper-unavailable'); return }
    this.child = child
    this.children.add(child)
    let buffer = ''
    const fail = () => {
      if (this.child !== child) return
      this.retireHelper()
      this.publish('helper-disconnected')
    }
    child.on('error', fail)
    child.on('close', () => {
      clearTimeout(child.activityKillTimer)
      this.children.delete(child)
      if (this.child === child) {
        this.child = null
        this.idle = null
        this.publish('helper-disconnected')
      }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (this.closed || this.child !== child) return
      this.checkHealth()
      if (this.child !== child) return
      buffer += chunk
      if (buffer.length > 4096) { fail(); return }
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let value
        try { value = JSON.parse(line) } catch { fail(); return }
        if (value?.version !== 1 || !['active', 'idle', 'activity-unavailable'].includes(value.kind)) { fail(); return }
        this.idle = value.kind === 'activity-unavailable' ? null : value.kind
        this.idleAt = this.clock()
        this.publish()
      }
    })
  }

  async pollLock() {
    this.pending = true
    this.pollAt = this.clock()
    const abort = this.abort = new AbortController()
    try {
      const path = typeof this.path === 'function' ? this.path() : this.path
      if (!this.verified) hyprland.validateVersion(await this.request(path, 'j/version', { signal: abort.signal }))
      const lock = hyprland.lockState(await this.request(path, 'j/monitors', { signal: abort.signal }))
      if (abort.signal.aborted || this.closed) return
      this.checkHealth()
      if (abort.signal.aborted) return
      this.verified = true
      this.lock = lock
      this.lockAt = this.clock()
      this.publish()
    } catch {
      if (this.closed || abort.signal.aborted) return
      this.lock = null
      this.verified = false
      this.publish('lock-unavailable')
    } finally { this.pending = false }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.clear(this.timer)
    this.abort?.abort()
    this.retireHelper()
    for (const child of this.children) {
      if (!child.activityKillTimer) {
        child.kill('SIGTERM')
        child.activityKillTimer = setTimeout(() => child.kill('SIGKILL'), 500)
      }
    }
  }
}

// Owns the privacy boundary around the existing FootObserver without changing
// its API or the public native WindowInfo. Ignore all cached subscription payloads
// while gated; restoration always asks native for a fresh snapshot.
class ActivityGate {
  constructor({ ledger, observer, native, clock, onError = () => {} }) {
    Object.assign(this, { ledger, observer, native, clock, onError })
  }
  signal(signal) {
    const old = this.ledger.activity
    // Conservatively exclude unaccrued scheduling gaps, not the stale focus.
    this.ledger.setActivity(signal, signal.gap ? this.ledger.updated : this.clock())
    if (old !== signal.kind || signal.gap) {
      this.observer.identity = null
      this.observer.context = null
    }
    if (old !== 'active' && signal.kind === 'active') this.refresh()
  }
  refresh() {
    if (this.ledger.activity !== 'active') return
    try {
      this.observer.observe(this.native.activeWindow())
      if (this.observer.enabled && !this.ledger.paused) {
        if (!this.observer.poll()) this.onError()
      }
    } catch { this.onError(); this.observer.fail() }
  }
}

module.exports = { ActivityProvider, ActivityGate, activityMetadata }
