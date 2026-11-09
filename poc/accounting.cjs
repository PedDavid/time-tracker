'use strict'

// Pure monotonic accounting. The clock and observations are injected for tests.
// Titles are optional, explicitly supplied by the caller. Never receives PIDs,
// full executable paths, or command arguments.
class Accounting {
  constructor(now, restored = null) {
    this.started = now
    this.updated = now
    this.elapsedBefore = restored?.elapsedMs || 0
    this.paused = restored?.state.kind === 'paused'
    this.focus = null
    this.focusTitle = null
    this.availability = 'waiting'
    this.apps = new Map(restored?.apps || [])
    this.details = new Map((restored?.details || []).map((detail) => [JSON.stringify([detail.app, detail.title]), { ...detail }]))
    this.excluded = new Map(restored?.excluded || [])
  }

  state() {
    if (this.paused) return { kind: 'paused' }
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
    this.updated = now
  }

  observe(app, now, title = null) {
    this.accrue(now)
    this.focus = app || null
    this.focusTitle = title
    this.availability = 'ready'
  }

  unavailable(now) {
    this.accrue(now)
    this.focus = null
    this.focusTitle = null
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
      state: this.state(),
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
