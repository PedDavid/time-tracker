'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { performance } = require('node:perf_hooks')

test('SIGKILL recovery retains titles/totals, releases writer lock, and excludes downtime', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-recovery-'))
  let child
  try {
    const fixture = join(dir, 'native.cjs')
    const state = join(dir, 'state.json')
    writeFileSync(fixture, `
      exports.activeWindow = () => ({ id: 1, info: { name: 'fixture.Editor' }, title: 'Synthetic recovery title' });
      exports.subscribeActiveWindow = () => 1;
      exports.unsubscribeActiveWindow = () => {};
    `)
    const args = [join(__dirname, 'tracker.cjs'), '--native', fixture, '--state', state, '--flush', '0.1', '--titles', '--json']
    child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const deadline = Date.now() + 3000
    for (;;) {
      let record
      try { record = JSON.parse(readFileSync(state, 'utf8')) } catch {}
      if (record?.snapshot.trackedMs > 150) break
      assert.equal(child.exitCode, null, stderr)
      assert.ok(Date.now() < deadline, `Periodic checkpoint missing: ${stderr}`)
      await sleep(20)
    }
    const competitor = spawnSync(process.execPath, [...args, '--duration', '0.1'], { encoding: 'utf8', timeout: 2000 })
    assert.equal(competitor.status, 1)
    assert.match(competitor.stderr, /Another tracker/)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    const before = JSON.parse(readFileSync(state, 'utf8'))
    assert.ok(before.snapshot.details.some((detail) => detail.title === 'Synthetic recovery title'))
    await sleep(500) // Must NOT be billed on recovery.
    const started = performance.now()
    const resumed = spawnSync(process.execPath, [...args, '--duration', '0.12'], { encoding: 'utf8', timeout: 3000 })
    const runtime = performance.now() - started
    assert.equal(resumed.status, 0, resumed.stderr)
    const report = JSON.parse(resumed.stdout)
    assert.equal(report.persisted, true)
    assert.ok(report.trackedMs > before.snapshot.trackedMs)
    assert.ok(report.elapsedMs - before.snapshot.elapsedMs < runtime + 20, 'Stopped time was counted')
    const final = JSON.parse(readFileSync(state, 'utf8'))
    assert.equal(final.snapshot.trackedMs, report.trackedMs)
    assert.equal(final.snapshot.elapsedMs, report.elapsedMs)
    // No title-policy downgrade that accidentally prints previously saved titles.
    const withoutTitles = spawnSync(process.execPath, args.filter((arg) => arg !== '--titles'), { encoding: 'utf8', timeout: 2000 })
    assert.equal(withoutTitles.status, 1)
    assert.match(withoutTitles.stderr, /title policy differs/)
    assert.ok(!withoutTitles.stdout.includes('Synthetic recovery title'))
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), final)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
