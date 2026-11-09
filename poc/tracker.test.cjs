'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

test('CLI accounts synthetic focus changes, outage, recovery and shuts down cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'time-tracker-poc-'))
  try {
    const fixture = join(dir, 'native-fixture.cjs')
    writeFileSync(fixture, `
      const window = (name) => ({ id: name ? 1 : 0, info: { name }, title: 'SYNTHETIC_TITLE_MUST_NOT_APPEAR' });
      let timers = [];
      exports.activeWindow = () => window('fixture.Editor');
      exports.subscribeActiveWindow = (callback) => {
        timers = [
          setTimeout(() => callback(null, window('fixture.Editor')), 0),
          setTimeout(() => callback(null, window('fixture.Browser')), 50),
          setTimeout(() => callback(null, window(null)), 100),
          setTimeout(() => callback(new Error('Synthetic disconnect')), 150),
          setTimeout(() => callback(null, window('fixture.Editor')), 200),
        ];
        return 1;
      };
      exports.unsubscribeActiveWindow = (id) => {
        if (id !== 1) throw new Error('Unexpected subscription');
        timers.forEach(clearTimeout);
      };
    `)
    // These focus/accounting fixtures deliberately do not emulate activity sensors.
    const result = spawnSync(process.execPath, [join(__dirname, 'tracker.cjs'), '--no-activity', '--no-state', '--native', fixture, '--duration', '0.35', '--json'], {
      encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.ok(!result.stdout.includes('SYNTHETIC_TITLE_MUST_NOT_APPEAR'))
    const report = JSON.parse(result.stdout)
    assert.equal(report.errors, 1)
    assert.ok(report.apps.some(([app, ms]) => app === 'fixture.Editor' && ms > 0))
    assert.ok(report.apps.some(([app, ms]) => app === 'fixture.Browser' && ms > 0))
    assert.ok(report.excluded.some(([kind, ms]) => kind === 'no focus' && ms > 0))
    assert.ok(report.excluded.some(([kind, ms]) => kind === 'IPC unavailable' && ms > 0))
    const accounted = report.trackedMs + report.excluded.reduce((sum, [, ms]) => sum + ms, 0)
    assert.ok(Math.abs(accounted - report.elapsedMs) < 0.001)
    assert.equal(report.persisted, false)
    assert.equal(report.lockDetection, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI exports HTML with titles only when explicitly enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'time-tracker-html-'))
  try {
    const fixture = join(dir, 'fixture.cjs')
    writeFileSync(fixture, `
      exports.activeWindow = () => ({ id: 1, info: { name: 'fixture.Browser' }, title: 'SYNTHETIC_PRIVATE_TAB' });
      exports.subscribeActiveWindow = () => 1;
      exports.unsubscribeActiveWindow = () => {};
    `)
    for (const enabled of [false, true]) {
      const htmlPath = join(dir, `${enabled}.html`)
      const args = [join(__dirname, 'tracker.cjs'), '--no-activity', '--no-state', '--native', fixture, '--duration', '0.1', '--json', '--html', htmlPath]
      if (enabled) args.push('--titles')
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 3000 })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stderr, /HTML report saved/)
      const report = JSON.parse(result.stdout)
      assert.equal(report.persisted, true)
      assert.equal(report.titlesEnabled, enabled)
      assert.equal(result.stdout.includes('SYNTHETIC_PRIVATE_TAB'), enabled)
      const html = readFileSync(htmlPath, 'utf8')
      assert.equal(html.includes('SYNTHETIC_PRIVATE_TAB'), enabled)
      assert.match(html, /fixture.Browser/)
      // The same command must not overwrite an existing report.
      const again = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 3000 })
      assert.equal(again.status, 1)
      assert.match(again.stderr, /EEXIST/)
      assert.equal(JSON.parse(again.stdout).persisted, false)
      assert.equal(readFileSync(htmlPath, 'utf8'), html)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI rejects invalid polling interval before loading an addon', () => {
  const result = spawnSync(process.execPath, [join(__dirname, 'tracker.cjs'), '--interval', '1'], { encoding: 'utf8', timeout: 2000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /between 50 and 60000/)
})
