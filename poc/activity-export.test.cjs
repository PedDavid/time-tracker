'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { Accounting } = require('./accounting.cjs')
const { activityMetadata } = require('./activity.cjs')
const { readCheckpoint } = require('./checkpoint-reader.cjs')
const { renderHtml } = require('./html-report.cjs')

function fixture(t, { kind = 'active', enabled = true, paused = false } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'focus-activity-export-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ledger = new Accounting(0)
  ledger.setActivity({ kind: 'activity-unavailable' }, 0)
  ledger.setActivity({ kind: 'active' }, 100)
  ledger.observe('fixture.foot', 100, 'Synthetic agent label', {
    status: 'resolved', executable: 'pi', label: 'Synthetic agent label', labelSource: 'window-title',
  })
  ledger.setActivity({ kind }, 200)
  if (paused) ledger.togglePause(200)
  const record = {
    version: 3, titlesEnabled: true, footEnabled: true,
    startedAt: '2026-01-01T00:00:00.000Z', savedAt: '2026-01-01T00:00:01.000Z', errors: 0,
    activityDetection: activityMetadata(enabled, 60000), snapshot: ledger.snapshot(300),
  }
  const path = join(dir, 'state.json')
  const save = () => fs.writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
  save()
  return { record, path, save }
}

test('activity-enabled checkpoint export preserves every gate state and all accounting dimensions', (t) => {
  for (const kind of ['active', 'idle', 'locked', 'activity-unavailable']) {
    const { record, path } = fixture(t, { kind })
    const report = readCheckpoint(path, true, true)
    for (const key of ['elapsedMs', 'trackedMs', 'apps', 'excluded', 'details', 'terminals', 'agentLabels', 'state', 'manualPaused', 'activity']) {
      assert.deepEqual(report[key], record.snapshot[key], `${kind}: ${key}`)
    }
    assert.deepEqual(report.activityDetection, { ...record.activityDetection, status: kind })
    const html = renderHtml(report)
    assert.match(html, /Automatic idle\/lock gating was enabled at this snapshot/)
    assert.ok(html.includes(`signal: ${kind}`))
    assert.match(html, /Input-idle cutoff: 00:01:00/)
    assert.match(html, /not necessarily all resumed history/)
    assert.doesNotMatch(html, /Idle and session lock are not detected/)
    assert.equal(report.trackedMs, kind === 'active' ? 200 : 100)
  }
})

test('live export distinguishes explicit opt-out, manual pause and unrecorded historical policy', (t) => {
  const disabled = fixture(t, { enabled: false })
  const off = readCheckpoint(disabled.path, true, true)
  assert.equal(off.activityDetection.enabled, false)
  assert.match(renderHtml(off), /Automatic idle\/lock gating was explicitly disabled/)

  const mixed = fixture(t)
  mixed.record.activityDetection.historyComplete = false
  mixed.save()
  assert.match(renderHtml(readCheckpoint(mixed.path, true, true)), /Earlier history was not fully gated/)

  const paused = fixture(t, { kind: 'locked', paused: true })
  const pausedReport = readCheckpoint(paused.path, true, true)
  assert.equal(pausedReport.manualPaused, true)
  assert.equal(pausedReport.state.kind, 'paused')
  assert.equal(pausedReport.activityDetection.status, 'locked')

  delete disabled.record.activityDetection
  delete disabled.record.snapshot.activity
  delete disabled.record.snapshot.manualPaused
  disabled.save()
  const legacy = readCheckpoint(disabled.path, true, true)
  assert.equal(legacy.activityDetection, undefined)
  assert.equal(legacy.idleDetection, undefined)
  assert.equal(legacy.lockDetection, undefined)
  assert.match(renderHtml(legacy), /No automatic activity policy was recorded/)
})

test('export rejects invalid activity capability metadata without echoing private values', (t) => {
  const { record, path, save } = fixture(t)
  const secret = 'Synthetic private <script>capability</script>'
  record.activityDetection.idleSource = secret
  save()
  assert.throws(() => readCheckpoint(path, true, true), (error) => {
    assert.match(error.message, /invalid or incompatible/)
    assert.ok(!error.message.includes(secret))
    return true
  })
})
