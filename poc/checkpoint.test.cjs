'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { Accounting } = require('./accounting.cjs')
const { Checkpoint } = require('./checkpoint.cjs')

function record(titles = false) {
  const ledger = new Accounting(0)
  ledger.observe('fixture.Editor', 0, titles ? 'Synthetic title' : null)
  return { version: 1, startedAt: '2026-01-01T00:00:00Z', savedAt: '2026-01-01T00:00:01Z',
    titlesEnabled: titles, errors: 0, snapshot: ledger.snapshot(1000) }
}
function temporary(work) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'focus-checkpoint-'))
  try { return work(join(dir, 'state.json'), dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('round trip private atomic checkpoint, reject concurrent writer, release lock', () => temporary((path, dir) => {
  const store = new Checkpoint(path, true)
  try {
    assert.equal(store.record, null)
    store.save(record(true))
    assert.equal(fs.statSync(path).mode & 0o777, 0o600)
    assert.equal(fs.statSync(`${path}.lock`).mode & 0o777, 0o600)
    assert.throws(() => new Checkpoint(path, true), /Another tracker/)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json', 'state.json.lock'])
  } finally { store.close() }
  const resumed = new Checkpoint(path, true)
  try { assert.deepEqual(resumed.record, record(true)) } finally { resumed.close() }
}))

test('restore totals without attributing downtime or stale focus/title; retain paused status', () => {
  const saved = record(true)
  const resumed = new Accounting(1000000, saved.snapshot)
  assert.equal(resumed.state().kind, 'waiting')
  let snapshot = resumed.snapshot(1000100)
  assert.equal(snapshot.elapsedMs, 1100)
  assert.equal(snapshot.trackedMs, 1000)
  assert.deepEqual(snapshot.excluded, [['waiting', 100]])
  resumed.observe('fixture.Browser', 1000100, 'Synthetic other tab')
  snapshot = resumed.snapshot(1000300)
  assert.equal(snapshot.trackedMs, 1200)
  assert.equal(snapshot.details[0].title, 'Synthetic title')
  const paused = record()
  paused.snapshot.state = { kind: 'paused' }
  const pausedLedger = new Accounting(9999999, paused.snapshot)
  pausedLedger.observe('fixture.Browser', 9999999)
  assert.equal(pausedLedger.snapshot(10000999).trackedMs, 1000)
})

test('corrupt checkpoint and title-policy mismatch are preserved, not silently reset', () => temporary((path) => {
  fs.writeFileSync(path, '{broken', { mode: 0o600 })
  assert.throws(() => new Checkpoint(path, false), /malformed JSON/)
  assert.equal(fs.readFileSync(path, 'utf8'), '{broken')
  fs.writeFileSync(path, JSON.stringify(record(true)))
  assert.throws(() => new Checkpoint(path, false), /title policy differs/)
  assert.equal(JSON.parse(fs.readFileSync(path)).titlesEnabled, true)
  const bad = record(); bad.snapshot.elapsedMs = 50000
  fs.writeFileSync(path, JSON.stringify(bad))
  assert.throws(() => new Checkpoint(path, false), /Invalid checkpoint/)
}))

test('failed rename retains previous checkpoint and cleans temporary file', () => temporary((path, dir) => {
  const store = new Checkpoint(path, false)
  const originalRename = fs.renameSync
  try {
    store.save(record())
    const before = fs.readFileSync(path, 'utf8')
    fs.renameSync = () => { const error = new Error('Synthetic write error'); error.code = 'EIO'; throw error }
    assert.throws(() => store.save({ ...record(), errors: 1 }), { code: 'EIO' })
    assert.equal(fs.readFileSync(path, 'utf8'), before)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json', 'state.json.lock'])
  } finally { fs.renameSync = originalRename; store.close() }
}))

test('checkpoint and lock symlinks are not followed', () => temporary((path, dir) => {
  const target = join(dir, 'other.json')
  fs.writeFileSync(target, JSON.stringify(record()), { mode: 0o600 })
  fs.symlinkSync(target, path)
  assert.throws(() => new Checkpoint(path, false), { code: 'ELOOP' })
  fs.unlinkSync(path)
  fs.unlinkSync(`${path}.lock`)
  fs.symlinkSync(target, `${path}.lock`)
  assert.throws(() => new Checkpoint(path, false), { code: 'ELOOP' })
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), record())
}))
