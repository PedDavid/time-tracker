'use strict'

// Pure monotonic accounting. The clock and observations are injected for tests.
// Titles are optional, explicitly supplied by the caller. Never receives PIDs,
// full executable paths, or command arguments.
class Accounting {
  constructor(now, restored = null) {
    this.started = now
    this.updated = now
    this.elapsedBefore = restored?.elapsedMs || 0
    this.paused = Boolean(restored?.manualPaused || restored?.state.kind === 'paused')
    // The caller enables automatic gating explicitly; never restore an old
    // activity signal (or focused window) from a checkpoint.
    this.activity = 'active'
    this.focus = null
    this.focusTitle = null
    this.focusTerminal = null
    this.availability = 'waiting'
    this.apps = new Map(restored?.apps || [])
    this.details = new Map((restored?.details || []).map((detail) => [JSON.stringify([detail.app, detail.title]), { ...detail }]))
    this.excluded = new Map(restored?.excluded || [])
    this.terminals = new Map((restored?.terminals || []).map((row) => [JSON.stringify([row.app, row.executable, row.reason]), { ...row }]))
    this.agentLabels = new Map((restored?.agentLabels || []).map((row) => [JSON.stringify([row.app, row.executable, row.label]), { ...row }]))
  }

  state() {
    if (this.paused) return { kind: 'paused' }
    if (this.activity !== 'active') return { kind: this.activity }
    if (this.availability !== 'ready') return { kind: this.availability }
    return this.focus ? { kind: 'tracking', app: this.focus } : { kind: 'no focus' }
  }

  accrue(now) {
    if (!Number.isFinite(now) || now < this.updated) throw new Error('Clock must be monotonic')
    const duration = now - this.updated
    const state = this.state()
    const bucket = state.kind === 'tracking' ? this.apps : this.excluded
    const key = state.app || state.kind
    bucket.set(key, (bucket.get(key) || 0) + duration)
    if (state.kind === 'tracking' && this.focusTitle !== null && duration > 0) {
      const detailKey = JSON.stringify([state.app, this.focusTitle])
      const detail = this.details.get(detailKey) || { app: state.app, title: this.focusTitle, ms: 0 }
      detail.ms += duration
      this.details.set(detailKey, detail)
    }
    if (state.kind === 'tracking' && this.focusTerminal && duration > 0) {
      // Persist only a basename or an explicit unknown reason, never owner or
      // foreground PIDs/paths. This dimension does not replace app/title totals.
      const executable = this.focusTerminal.status === 'resolved' ? this.focusTerminal.executable : null
      const reason = executable ? null : this.focusTerminal.reason
      const key = JSON.stringify([state.app, executable, reason])
      const row = this.terminals.get(key) || { app: state.app, executable, reason, ms: 0 }
      row.ms += duration
      this.terminals.set(key, row)
      const context = this.focusTerminal
      if (executable && ['pi', 'claude'].includes(executable) && context.labelSource === 'window-title' &&
          context.label && context.label === this.focusTitle) {
        // Only correlate a title observed alongside a resolved agent process.
        // A later title-only update waits for another proc observation instead
        // of carrying a stale label across agents/sessions in the same window.
        const key = JSON.stringify([state.app, executable, context.label])
        const labelRow = this.agentLabels.get(key) || { app: state.app, executable, label: context.label, source: 'window-title', ms: 0 }
        labelRow.ms += duration
        this.agentLabels.set(key, labelRow)
      }
    }
    this.updated = now
  }

  setActivity(signal, now) {
    if (!signal || !['active', 'idle', 'locked', 'activity-unavailable'].includes(signal.kind)) throw new Error('Invalid activity signal')
    this.accrue(now)
    if (this.activity !== signal.kind) {
      this.focus = null
      this.focusTitle = null
      this.focusTerminal = null
      this.availability = 'waiting'
    }
    this.activity = signal.kind
  }

  observe(app, now, title = null, terminal = null) {
    this.accrue(now)
    if (this.activity !== 'active') return
    this.focus = app || null
    this.focusTitle = title
    this.focusTerminal = terminal
    this.availability = 'ready'
  }

  unavailable(now) {
    this.accrue(now)
    this.focus = null
    this.focusTitle = null
    this.focusTerminal = null
    this.availability = 'IPC unavailable'
  }

  togglePause(now) {
    this.accrue(now)
    this.paused = !this.paused
    return this.paused
  }

  snapshot(now) {
    this.accrue(now)
    const apps = [...this.apps].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1])
    const excluded = [...this.excluded].filter(([, ms]) => ms > 0)
    return {
      elapsedMs: this.elapsedBefore + now - this.started,
      trackedMs: apps.reduce((sum, [, ms]) => sum + ms, 0),
      apps,
      excluded,
      details: [...this.details.values()].map((detail) => ({ ...detail })).sort((a, b) => b.ms - a.ms),
      terminals: [...this.terminals.values()].map((row) => ({ ...row })).sort((a, b) => b.ms - a.ms),
      agentLabels: [...this.agentLabels.values()].map((row) => ({ ...row })).sort((a, b) => b.ms - a.ms),
      state: this.state(),
      manualPaused: this.paused,
      activity: this.activity,
    }
  }
}

function appLabel(window) {
  if (!window || window.id === 0) return null
  const info = window.info || {}
  // Class is available even when /proc cannot be read. Avoid owner PID as identity.
  const label = info.name || info.execName || 'Unknown application'
  return String(label).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, 80) || 'Unknown application'
}

function windowTitle(window, enabled = false) {
  if (!enabled || !window || window.id === 0) return null
  return String(window.title || '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, 240) || '(Untitled)'
}

module.exports = { Accounting, appLabel, windowTitle }
