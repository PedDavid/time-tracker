'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Accounting } = require('./accounting.cjs')
const { FootObserver } = require('./foot-observer.cjs')
const { validate } = require('./checkpoint.cjs')
const { renderHtml } = require('./html-report.cjs')

function fixture({ titles = true, enabled = true } = {}) {
  let now = 0
  let executable = 'pi'
  let title = 'π - Synthetic task A'
  const window = { id: 1, info: { name: 'foot', execName: 'foot', processId: 100 }, get title() { return title } }
  const ledger = new Accounting(0)
  const native = { activeWindow: () => window, openWindows: () => [window] }
  const observer = new FootObserver({ native, ledger, clock: () => now, titles, enabled,
    resolver: () => ({ status: 'resolved', executable, foregroundPid: 300, source: 'proc-pty-foreground-root' }) })
  return { ledger, native, observer, window, setNow: (value) => { now = value }, setTitle: (value) => { title = value }, setExecutable: (value) => { executable = value } }
}

function record(snapshot) {
  return { version: 3, footEnabled: true, titlesEnabled: true, startedAt: '2026-01-01', errors: 0, snapshot }
}

test('correlates named pi/Claude titles with foreground executable, preserving app totals', () => {
  const f = fixture()
  f.observer.poll()
  f.setNow(1000); f.setTitle('Claude — Synthetic task B'); f.setExecutable('claude'); f.observer.poll()
  const snapshot = f.ledger.snapshot(2000)
  assert.deepEqual(snapshot.apps, [['foot', 2000]])
  assert.deepEqual(snapshot.agentLabels, [
    { app: 'foot', executable: 'pi', label: 'π - Synthetic task A', source: 'window-title', ms: 1000 },
    { app: 'foot', executable: 'claude', label: 'Claude — Synthetic task B', source: 'window-title', ms: 1000 },
  ])
  validate(record(snapshot), true, true)
  assert.ok(!JSON.stringify(snapshot).includes('foregroundPid'))
})

test('title-only changes wait for another process observation, not stale session correlation', () => {
  const f = fixture()
  f.observer.poll()
  f.setNow(1000); f.setTitle('π - Synthetic task B'); f.observer.observe(f.window)
  // Returning to the old title must not resurrect an invalidated association.
  f.setNow(1200); f.setTitle('π - Synthetic task A'); f.observer.observe(f.window)
  f.setNow(1300); f.setTitle('π - Synthetic task B'); f.observer.observe(f.window)
  f.setNow(1500)
  assert.equal(f.ledger.snapshot(1500).agentLabels.length, 1)
  f.observer.poll()
  const snapshot = f.ledger.snapshot(2500)
  assert.deepEqual(snapshot.agentLabels.map((row) => [row.label, row.ms]), [
    ['π - Synthetic task A', 1000], ['π - Synthetic task B', 1000],
  ])
  assert.equal(snapshot.trackedMs, 2500) // 500 ms gap is tracked, but not label-correlated
  validate(record(snapshot), true, true)
})

test('titles off never reads title getter or infers labels; foot off has no agent labels', () => {
  const f = fixture({ titles: false })
  Object.defineProperty(f.window, 'title', { get() { throw new Error('Title access not opted in') } })
  f.observer.poll()
  const snapshot = f.ledger.snapshot(1000)
  assert.deepEqual(snapshot.agentLabels, [])
  assert.deepEqual(snapshot.details, [])
  assert.equal(snapshot.terminals[0].executable, 'pi')
  const disabled = fixture({ enabled: false })
  disabled.observer.observe(disabled.window)
  assert.deepEqual(disabled.ledger.snapshot(1000).agentLabels, [])
})

test('title text alone cannot identify an agent; unknown and shell contexts are not named', () => {
  const f = fixture()
  f.setExecutable('zsh')
  f.observer.poll()
  assert.deepEqual(f.ledger.snapshot(1000).agentLabels, [])
  f.setNow(1000)
  f.observer.resolver = () => ({ status: 'unknown', reason: 'multiple-foreground-roots' })
  f.observer.poll()
  assert.deepEqual(f.ledger.snapshot(2000).agentLabels, [])
})

test('pause, missing titles, disconnect and restored history never invent a current session', () => {
  const f = fixture()
  f.observer.poll()
  f.setNow(1000); f.ledger.togglePause(1000)
  assert.equal(f.ledger.snapshot(2000).agentLabels[0].ms, 1000)
  const restored = new Accounting(100000, f.ledger.snapshot(2000))
  assert.equal(restored.state().kind, 'paused')
  assert.equal(restored.focusTerminal, null)
  f.setNow(2000); f.ledger.togglePause(2000)
  f.setTitle(''); f.observer.poll()
  assert.equal(f.ledger.snapshot(3000).agentLabels[0].ms, 1000)
  f.setNow(3000); f.observer.fail()
  assert.equal(f.ledger.snapshot(4000).agentLabels[0].ms, 1000)
})

test('checkpoint guards labels by title/foot policy, source and dimension totals', () => {
  const f = fixture()
  f.observer.poll()
  const snapshot = f.ledger.snapshot(1000)
  validate(record(snapshot), true, true)
  assert.throws(() => validate(record(snapshot), false, true), /title policy/)
  assert.throws(() => validate(record(snapshot), true, false), /foot policy/)
  assert.throws(() => validate({ ...record(snapshot), version: 2 }, true, true), /Invalid checkpoint/)
  snapshot.agentLabels[0].source = 'verified-session-name'
  assert.throws(() => validate(record(snapshot), true, true), /Invalid checkpoint/)
  snapshot.agentLabels[0].source = 'window-title'
  snapshot.agentLabels[0].ms = 2000
  assert.throws(() => validate(record(snapshot), true, true), /Invalid checkpoint/)
  // Older v2 histories load without inventing retroactive label totals.
  delete snapshot.agentLabels
  validate({ ...record(snapshot), version: 2 }, true, true)
})

test('HTML labels are escaped and explicitly identified as title-derived', () => {
  const f = fixture()
  f.setTitle('π - <script>alert("synthetic")</script>')
  f.observer.poll()
  const html = renderHtml({ ...f.ledger.snapshot(1000), footEnabled: true, titlesEnabled: true })
  assert.match(html, /Agent session labels/)
  assert.match(html, /not verified session names or IDs/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})
