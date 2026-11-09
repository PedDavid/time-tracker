'use strict'
const { appLabel, windowTitle } = require('./accounting.cjs')
const { isFoot, resolveFoot } = require('./foot.cjs')
const { kiroWindowTitle } = require('./kiro.cjs')
const { isKitty, resolveKitty } = require('./kitty.cjs')

// PoC-local enrichment, separate from x-win's public API and change detection.
class FootObserver {
  constructor({ native, ledger, clock, titles = false, enabled = false, resolver = resolveFoot, kittyResolver = resolveKitty, kitty = false }) {
    Object.assign(this, { native, ledger, clock, titles, enabled, resolver, kittyResolver, kitty })
    this.identity = null
    this.context = null
  }

  // kitty is only observed when explicitly enabled (--terminals).
  isTerminal(window) { return isFoot(window) || (this.kitty && isKitty(window)) }

  observe(window) {
    const identity = this.enabled && this.isTerminal(window) ? `${window.id}:${window.info.processId}` : null
    const changed = identity !== this.identity
    if (changed || !identity) this.context = identity ? { status: 'unknown', reason: 'pending-observation' } : null
    this.identity = identity
    // Resumed Kiro CLI windows are titled with a session UUID; show the session name.
    const title = this.titles ? kiroWindowTitle(windowTitle(window, true), this.clock()) : windowTitle(window, false)
    if (this.context?.label && this.context.label !== title) {
      const { label, labelSource, ...unlabeled } = this.context
      this.context = unlabeled
    }
    this.ledger.observe(appLabel(window), this.clock(), title, this.context)
    return changed && identity !== null
  }

  fail() {
    this.identity = null
    this.context = null
    this.ledger.unavailable(this.clock())
  }

  poll() {
    if (!this.enabled || this.ledger.paused) return true
    try {
      const window = this.native.activeWindow()
      this.observe(window)
      if (!this.identity) return true
      const identity = this.identity
      const context = this.kitty && isKitty(window) ? this.kittyResolver(window) : this.resolver(window, this.native.openWindows())
      const after = this.native.activeWindow()
      // Focus may have moved while scanning proc. Never apply another window's
      // context to the new focus, even when both windows have the same class.
      const afterIdentity = this.isTerminal(after) ? `${after.id}:${after.info.processId}` : null
      if (afterIdentity === identity) {
        this.context = context || { status: 'unknown', reason: 'unavailable-proc-metadata' }
        if (this.context.status === 'resolved' && ['pi', 'claude'].includes(this.context.executable) && this.titles) {
          const label = windowTitle(after, true)
          if (label !== '(Untitled)') this.context = { ...this.context, label, labelSource: 'window-title' }
        }
      }
      this.observe(after)
      return true
    } catch {
      this.fail()
      return false
    }
  }
}
module.exports = { FootObserver }
