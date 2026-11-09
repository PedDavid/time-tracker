'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, statSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { renderHtml, writeHtml } = require('./html-report.cjs')
const { Accounting, windowTitle } = require('./accounting.cjs')

const summary = {
  elapsedMs: 10000, trackedMs: 8000,
  apps: [['fixture.Browser', 5000], ['fixture.Terminal', 3000]],
  excluded: [['paused', 2000]], errors: 0,
}

test('HTML has offline charts, totals and no active or external resources', () => {
  const html = renderHtml(summary)
  assert.match(html, /conic-gradient/)
  assert.match(html, /00:00:08/)
  assert.match(html, /62.5%/)
  assert.match(html, /Title collection was off/)
  assert.match(html, /Content-Security-Policy/)
  assert.doesNotMatch(html, /<script|<link|<iframe|https?:\/\//i)
})

test('untrusted titles, classes and excluded labels are HTML-escaped', () => {
  const attack = '</td><script>alert("private")</script>&'
  const html = renderHtml({ ...summary, titlesEnabled: true,
    apps: [[attack, 8000]], excluded: [[attack, 2000]],
    details: [{ app: attack, title: attack, ms: 8000 }],
  })
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&amp;/)
})

test('empty session and more than eight apps produce valid finite chart values', () => {
  for (const report of [
    { elapsedMs: 0, trackedMs: 0, apps: [], excluded: [] },
    { elapsedMs: 10000, trackedMs: 10000, apps: Array.from({ length: 10 }, (_, i) => [`fixture.App${i}`, 1000]), excluded: [] },
  ]) {
    const html = renderHtml(report)
    assert.doesNotMatch(html, /NaN|Infinity|conic-gradient\(\)/)
  }
})

test('export is private, refuses overwrite, preserves existing report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-html-'))
  try {
    const path = join(dir, 'report.html')
    writeHtml(path, summary)
    const original = readFileSync(path, 'utf8')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.throws(() => writeHtml(path, { ...summary, apps: [] }), { code: 'EEXIST' })
    assert.equal(readFileSync(path, 'utf8'), original)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('title collection is opt-in and title changes conserve app totals', () => {
  const privateWindow = { id: 1, get title() { throw new Error('Title collection disabled') } }
  assert.equal(windowTitle(privateWindow, false), null)
  assert.equal(windowTitle({ id: 0 }, true), null)
  const ledger = new Accounting(0)
  ledger.observe('fixture.Browser', 0, windowTitle({ id: 1, title: 'Synthetic tab A' }, true))
  ledger.observe('fixture.Browser', 1000, windowTitle({ id: 1, title: 'Synthetic tab B\n' }, true))
  ledger.togglePause(2000)
  const snapshot = ledger.snapshot(4000)
  assert.deepEqual(snapshot.apps, [['fixture.Browser', 2000]])
  assert.deepEqual(snapshot.details, [
    { app: 'fixture.Browser', title: 'Synthetic tab A', ms: 1000 },
    { app: 'fixture.Browser', title: 'Synthetic tab B', ms: 1000 },
  ])
  assert.equal(snapshot.details.reduce((total, detail) => total + detail.ms, 0), snapshot.trackedMs)
  snapshot.details[0].ms = 9999
  assert.equal(ledger.snapshot(4000).details[0].ms, 1000)
})
