'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { WatchedReport } = require('./report-watch.cjs')
const { Checkpoint } = require('./checkpoint.cjs')

const cli = join(__dirname, 'export-report.cjs')
function record(ms = 5000) {
  return {
    version: 1, startedAt: '2026-01-01T00:00:00.000Z', savedAt: new Date(Date.UTC(2026, 0, 1) + ms).toISOString(),
    titlesEnabled: false, footEnabled: false, errors: 0,
    snapshot: { elapsedMs: ms, trackedMs: ms, apps: [['fixture.Editor', ms]], excluded: [], details: [], state: { kind: 'tracking', app: 'fixture.Editor' } },
  }
}
function report(ms = 5000) {
  const r = record(ms)
  return { ...r.snapshot, startedAt: r.startedAt, errors: 0, checkpoint: { asOf: r.savedAt, timeSource: 'savedAt' } }
}
function directory(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'focus-watch-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function save(path, value) { fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 }) }
async function waitFor(predicate, child) {
  const until = Date.now() + 4000
  for (;;) {
    if (predicate()) return
    if (child) assert.equal(child.exitCode, null, 'Watcher exited unexpectedly')
    assert.ok(Date.now() < until, 'Timed out waiting for watched HTML')
    await sleep(20)
  }
}
function launch(t, state, html) {
  const child = spawn(process.execPath, [cli, '--state', state, '--html', html, '--watch', '--watch-interval', '0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let stderr = '', stdout = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.on('data', (chunk) => { stdout += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1000)
    await closed
    clearTimeout(force)
  })
  return { child, closed, stderr: () => stderr, stdout: () => stdout }
}

test('watched HTML is private, atomically replaced, and unchanged snapshots cause no rewrites', (t) => {
  const dir = directory(t), html = join(dir, 'report.html')
  const writer = new WatchedReport(html, report())
  assert.equal(fs.statSync(html).mode & 0o777, 0o600)
  const before = fs.statSync(html).ino
  const fd = fs.openSync(html, 'r')
  try {
    assert.equal(writer.update(report()), false)
    assert.equal(fs.statSync(html).ino, before)
    assert.equal(writer.update(report(12000)), true)
    assert.notEqual(fs.statSync(html).ino, before)
    assert.equal(fs.statSync(html).mode & 0o777, 0o600)
    assert.match(fs.readFileSync(fd, 'utf8'), /00:00:05/)
    assert.match(fs.readFileSync(html, 'utf8'), /00:00:12/)
    assert.deepEqual(fs.readdirSync(dir), ['report.html'])
    assert.throws(() => new WatchedReport(html, report()), { code: 'EEXIST' })
  } finally { fs.closeSync(fd) }
})

test('watch ownership checks refuse edited, removed, replaced, public, linked and symlink outputs', (t) => {
  for (const kind of ['edited', 'removed', 'replaced', 'public', 'hardlink', 'symlink']) {
    const dir = directory(t), html = join(dir, 'report.html'), other = join(dir, 'other.html')
    const writer = new WatchedReport(html, report())
    if (kind === 'edited') fs.writeFileSync(html, 'Synthetic external edit')
    if (kind === 'removed') fs.unlinkSync(html)
    if (kind === 'replaced') { fs.writeFileSync(other, 'Synthetic replacement'); fs.renameSync(other, html) }
    if (kind === 'public') fs.chmodSync(html, 0o644)
    if (kind === 'hardlink') fs.linkSync(html, other)
    if (kind === 'symlink') { fs.writeFileSync(other, 'Synthetic target'); fs.unlinkSync(html); fs.symlinkSync(other, html) }
    const before = fs.existsSync(html) ? fs.readFileSync(html) : null
    assert.throws(() => writer.update(report(12000)), { code: 'REPORT_CHANGED' }, kind)
    assert.throws(() => writer.update(report()), { code: 'REPORT_CHANGED' }, `${kind}: even an unchanged snapshot checks ownership`)
    if (before) assert.deepEqual(fs.readFileSync(html), before)
    else assert.equal(fs.existsSync(html), false)
    if (kind === 'symlink') assert.equal(fs.readFileSync(other, 'utf8'), 'Synthetic target')
  }
})

test('failed watched replacement preserves the previous report and cleans temporary files', (t) => {
  const dir = directory(t), html = join(dir, 'report.html')
  const writer = new WatchedReport(html, report()), before = fs.readFileSync(html)
  const original = fs.renameSync
  try {
    fs.renameSync = () => { throw Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' }) }
    assert.throws(() => writer.update(report(12000)), { code: 'EIO' })
  } finally { fs.renameSync = original }
  assert.deepEqual(fs.readFileSync(html), before)
  assert.deepEqual(fs.readdirSync(dir), ['report.html'])
  assert.equal(writer.update(report(12000)), true)
})

test('ownership is rechecked after preparing a new report, before publishing it', (t) => {
  const dir = directory(t), html = join(dir, 'report.html'), other = join(dir, 'other.html')
  const writer = new WatchedReport(html, report())
  fs.writeFileSync(other, 'Synthetic external replacement')
  const original = fs.fsyncSync
  try {
    fs.fsyncSync = (fd) => { original(fd); fs.renameSync(other, html) }
    assert.throws(() => writer.update(report(12000)), { code: 'REPORT_CHANGED' })
  } finally { fs.fsyncSync = original }
  assert.equal(fs.readFileSync(html, 'utf8'), 'Synthetic external replacement')
  assert.deepEqual(fs.readdirSync(dir), ['report.html'])
})

test('watch CLI updates the same file while writer flock is held; SIGTERM stops updates', { timeout: 10000 }, async (t) => {
  const dir = directory(t), state = join(dir, 'state.json'), html = join(dir, 'report.html')
  const store = new Checkpoint(state, false)
  // Register cleanup before directory removal; explicitly close in finally too.
  try {
    store.save(record())
    const lock = fs.statSync(`${state}.lock`, { bigint: true })
    const p = launch(t, state, html)
    await waitFor(() => fs.existsSync(html) && fs.readFileSync(html, 'utf8').includes('00:00:05'), p.child)
    store.save(record(12000))
    const before = fs.statSync(state, { bigint: true }), bytes = fs.readFileSync(state)
    await waitFor(() => fs.readFileSync(html, 'utf8').includes('00:00:12'), p.child)
    assert.deepEqual(fs.readFileSync(state), bytes)
    const after = fs.statSync(state, { bigint: true })
    for (const key of ['ino', 'mode', 'uid', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key])
    assert.equal(fs.statSync(`${state}.lock`, { bigint: true }).ino, lock.ino)
    assert.match(p.stderr(), /Ctrl\+R/)
    p.child.kill('SIGTERM')
    const [code] = await p.closed
    assert.equal(code, 0, p.stderr())
    assert.equal(p.stdout(), '')
    const final = fs.readFileSync(html)
    store.save(record(22000))
    await sleep(200)
    assert.deepEqual(fs.readFileSync(html), final)
  } finally { store.close() }
})

test('watch CLI stops on changed privacy policy, retaining the last successful report', { timeout: 10000 }, async (t) => {
  const dir = directory(t), state = join(dir, 'state.json'), html = join(dir, 'report.html')
  save(state, record())
  const p = launch(t, state, html)
  await waitFor(() => fs.existsSync(html) && fs.readFileSync(html, 'utf8').includes('</html>'), p.child)
  const before = fs.readFileSync(html)
  const next = record(12000)
  next.titlesEnabled = true
  next.snapshot.details = [{ app: 'fixture.Editor', title: 'SYNTHETIC_PRIVATE_TITLE', ms: 12000 }]
  save(join(dir, 'next.json'), next)
  fs.renameSync(join(dir, 'next.json'), state)
  const [code] = await p.closed
  assert.equal(code, 1)
  assert.match(p.stderr(), /Watch export failed/)
  assert.ok(!p.stderr().includes('SYNTHETIC_PRIVATE_TITLE'))
  assert.deepEqual(fs.readFileSync(html), before)
})

test('watch CLI refuses existing output and invalid watch options before writing', (t) => {
  const dir = directory(t), state = join(dir, 'state.json'), html = join(dir, 'report.html')
  save(state, record())
  fs.writeFileSync(html, 'Synthetic existing report')
  const result = spawnSync(process.execPath, [cli, '--state', state, '--html', html, '--watch'], { encoding: 'utf8', timeout: 3000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /new --html filename/)
  assert.equal(fs.readFileSync(html, 'utf8'), 'Synthetic existing report')
  for (const flags of [['--watch-interval', '1'], ['--watch', '--watch-interval', '0'], ['--watch', '--watch-interval', 'NaN'], ['--watch', '--watch-interval', '3601'], ['--watch', '--watch-interval']]) {
    const output = join(dir, 'must-not-exist.html')
    const bad = spawnSync(process.execPath, [cli, '--state', state, '--html', output, ...flags], { encoding: 'utf8', timeout: 3000 })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /watch-interval/)
    assert.equal(fs.existsSync(output), false)
  }
})
