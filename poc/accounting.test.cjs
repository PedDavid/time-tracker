'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Accounting, appLabel } = require('./accounting.cjs')

test('app switching, repeated observations and no focus are accounted exactly', () => {
  const ledger = new Accounting(0)
  ledger.observe('fixture.Editor', 100)
  ledger.observe('fixture.Editor', 1100) // title update / another window of same app
  ledger.observe('fixture.Browser', 2100)
  ledger.observe(null, 3100)
  const report = ledger.snapshot(4100)
  assert.deepEqual(report.apps, [['fixture.Editor', 2000], ['fixture.Browser', 1000]])
  assert.deepEqual(report.excluded, [['waiting', 100], ['no focus', 1000]])
  assert.equal(report.elapsedMs, 4100)
  assert.equal(report.trackedMs, 3000)
})

test('pause excludes time, tracks focus changes while paused, resumes latest app', () => {
  const ledger = new Accounting(0)
  ledger.observe('fixture.Editor', 0)
  ledger.togglePause(1000)
  ledger.observe('fixture.Browser', 2000)
  ledger.togglePause(5000)
  const report = ledger.snapshot(6000)
  assert.deepEqual(report.apps, [['fixture.Editor', 1000], ['fixture.Browser', 1000]])
  assert.deepEqual(report.excluded, [['paused', 4000]])
})

test('IPC outage clears attribution and recovery resumes without stale activity', () => {
  const ledger = new Accounting(0)
  ledger.observe('fixture.Editor', 0)
  ledger.unavailable(1000)
  ledger.unavailable(2000)
  ledger.observe('fixture.Browser', 4000)
  const report = ledger.snapshot(5000)
  assert.deepEqual(report.apps, [['fixture.Editor', 1000], ['fixture.Browser', 1000]])
  assert.deepEqual(report.excluded, [['IPC unavailable', 3000]])
})

test('snapshots do not double count; backwards clocks fail safely', () => {
  const ledger = new Accounting(0)
  ledger.observe('fixture.Editor', 0)
  assert.equal(ledger.snapshot(1000).trackedMs, 1000)
  assert.equal(ledger.snapshot(2000).trackedMs, 2000)
  assert.equal(ledger.snapshot(2000).trackedMs, 2000)
  assert.throws(() => ledger.snapshot(1000), /monotonic/)
  assert.throws(() => ledger.snapshot(NaN), /monotonic/)
})

test('pause survives disconnect and recovery; all elapsed time is conserved', () => {
  const ledger = new Accounting(0)
  ledger.observe('fixture.Editor', 100)
  ledger.togglePause(1000)
  ledger.unavailable(2000)
  ledger.observe('fixture.Browser', 3000)
  assert.equal(ledger.snapshot(4000).state.kind, 'paused')
  ledger.togglePause(5000)
  const report = ledger.snapshot(6000)
  assert.equal(report.trackedMs + report.excluded.reduce((sum, [, ms]) => sum + ms, 0), report.elapsedMs)
  assert.deepEqual(report.apps, [['fixture.Browser', 1000], ['fixture.Editor', 900]])
})

test('labels do not inspect titles, paths, arguments or PIDs; controls stripped', () => {
  const window = {
    id: 1,
    info: { name: 'fixture.Editor\n\r\x1b\u202e', get path() { throw new Error('must not read') } },
    get title() { throw new Error('must not read') },
  }
  assert.equal(appLabel(window), 'fixture.Editor')
  assert.equal(appLabel({ id: 0 }), null)
  assert.equal(appLabel(null), null)
  assert.equal(appLabel({ id: 1, info: { execName: 'editor' } }), 'editor')
  assert.equal(appLabel({ id: 1 }), 'Unknown application')
  assert.equal(appLabel({ id: 1, info: { name: 'a'.repeat(1000) } }).length, 80)
})
