'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveFoot, parseStat, SOURCE } = require('./foot.cjs')
const { FootObserver } = require('./foot-observer.cjs')
const { Accounting } = require('./accounting.cjs')
const { validate } = require('./checkpoint.cjs')
const { renderHtml } = require('./html-report.cjs')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')

const window = { id: 1, title: 'Synthetic unchanged title', info: { name: 'foot', execName: 'foot', processId: 100 } }
function fixture() {
  const stat = (pid, ppid, pgrp, session, tty, tpgid) => ({ pid, ppid, pgrp, session, tty, tpgid, start: String(pid * 100), state: 'S' })
  const stats = {
    100: stat(100, 1, 100, 100, 0, -1),
    200: stat(200, 100, 200, 200, 34817, 300),
    300: stat(300, 200, 300, 200, 34817, 300),
    400: stat(400, 200, 400, 200, 34817, 300), // background job, not foreground
  }
  const paths = { 100: '/usr/bin/foot', 200: '/usr/bin/zsh', 300: '/usr/bin/nvim', 400: '/usr/bin/build' }
  const provider = {
    stat: (pid) => { if (!stats[pid]) { const e = new Error('Synthetic exit'); e.code = 'ENOENT'; throw e } return { ...stats[pid] } },
    executable: (pid) => paths[pid],
    children: () => [200], fds: () => ['6'], fdinfo: () => 'pos:\t0\ntty-index:\t1\n',
    ttyDevice: (index) => ({ character: true, major: 136, minor: index }),
    pids: () => Object.keys(stats).map(Number),
  }
  return { stats, paths, provider, resolve: () => resolveFoot(window, [window], provider, () => 0) }
}

test('stat parser handles parentheses/spaces in comm and preserves start-time identity', () => {
  const fields = ['S', '100', '300', '200', '34817', '300', ...Array(13).fill('0'), '123456']
  assert.deepEqual(parseStat(`300 (synthetic ) name) ${fields.join(' ')}`), {
    pid: 300, ppid: 100, pgrp: 300, session: 200, tty: 34817, tpgid: 300, start: '123456', state: 'S',
  })
  assert.throws(() => parseStat('bad stat'))
})

test('foreground executable, shell restoration and background exclusion; owner unchanged', () => {
  const f = fixture()
  const original = JSON.stringify(window)
  assert.deepEqual(f.resolve(), { status: 'resolved', executable: 'nvim', foregroundPid: 300, source: SOURCE })
  f.stats[200].tpgid = 200
  f.stats[300].tpgid = 200
  assert.equal(f.resolve().executable, 'zsh')
  assert.equal(JSON.stringify(window), original)
})

test('unique foreground root wins over descendants, never the deepest child', () => {
  const f = fixture()
  f.paths[300] = '/usr/bin/agent'
  f.stats[350] = { ...f.stats[300], pid: 350, ppid: 300, start: '35000' }
  f.paths[350] = '/usr/bin/helper'
  assert.equal(f.resolve().executable, 'agent')
})

test('shared owner and multiple PTYs are unknown, never another window’s job', () => {
  const f = fixture()
  assert.equal(resolveFoot(window, [window, { ...window, id: 2 }], f.provider).reason, 'shared-or-missing-window-owner')
  f.provider.fds = () => ['6', '7']
  f.provider.fdinfo = (_, fd) => `tty-index:\t${fd === '6' ? 1 : 2}\n`
  assert.equal(f.resolve().reason, 'multiple-ptys')
  f.provider.fdinfo = () => 'tty-index:\t1\n' // duplicated master FD is still one PTY
  assert.equal(f.resolve().executable, 'nvim')
})

test('different terminal controlling TTY cannot be used as association evidence', () => {
  const f = fixture()
  f.stats[200].tty = 34818
  assert.equal(f.resolve().reason, 'missing-tty-anchor')
})

test('PTY device matching handles minor numbers above 255', () => {
  const f = fixture()
  f.provider.fdinfo = () => 'tty-index:\t257\n'
  for (const stat of Object.values(f.stats)) if (stat.tty) stat.tty = (136 << 8) | 1 | (256 << 12)
  assert.equal(f.resolve().executable, 'nvim')
})

test('pipeline roots are ambiguous, including deterministic member ordering', () => {
  const f = fixture()
  f.stats[301] = { ...f.stats[300], pid: 301, start: '30100' }
  f.paths[301] = '/usr/bin/filter'
  assert.equal(f.resolve().reason, 'multiple-foreground-roots')
  f.provider.pids = () => [400, 301, 300, 200, 100]
  assert.equal(f.resolve().reason, 'multiple-foreground-roots')
  delete f.stats[300]
  assert.equal(f.resolve().reason, 'foreground-leader-unavailable')
})

test('SSH and multiplexers are reported locally, not descended into', () => {
  const f = fixture()
  for (const name of ['ssh', 'tmux', 'screen']) {
    f.paths[300] = `/usr/bin/${name}`
    assert.equal(f.resolve().executable, name)
  }
})

test('PID reuse, exec change and foreground-group race invalidate snapshots', () => {
  for (const type of ['pid', 'exe', 'group']) {
    const f = fixture()
    const stat = f.provider.stat
    let reads = 0
    if (type === 'exe') {
      f.provider.executable = (pid) => pid === 300 ? (++reads === 1 ? '/usr/bin/nvim' : '/usr/bin/other') : f.paths[pid]
    } else {
      f.provider.stat = (pid) => {
        const result = stat(pid)
        if (pid === 300 && ++reads >= 2) return { ...result, ...(type === 'pid' ? { start: '99999' } : { pgrp: 999 }) }
        return result
      }
    }
    assert.equal(f.resolve().reason, 'process-race')
  }
})

test('permission denial, exit, scan limits and total deadline fail closed', () => {
  const f = fixture()
  f.provider.executable = () => { const e = new Error('Synthetic deny'); e.code = 'EACCES'; throw e }
  assert.equal(f.resolve().reason, 'permission-denied')
  delete f.stats[100]
  assert.equal(f.resolve().reason, 'process-exited')
  const limited = fixture()
  limited.provider.pids = () => Array(4097).fill(1)
  assert.equal(limited.resolve().reason, 'process-scan-limit')
  const timed = fixture()
  let now = 0
  assert.equal(resolveFoot(window, [window], timed.provider, () => now += 20).reason, 'scan-timeout')
})

test('independent context refresh tracks shell → command → shell with identical title', () => {
  const ledger = new Accounting(0)
  let now = 0
  let executable = 'zsh'
  const native = { activeWindow: () => window, openWindows: () => [window] }
  const observer = new FootObserver({ native, ledger, clock: () => now, enabled: true,
    resolver: () => ({ status: 'resolved', executable, foregroundPid: 300, source: SOURCE }) })
  observer.poll()
  now = 1000; executable = 'nvim'; observer.poll()
  now = 2000; executable = 'zsh'; observer.poll()
  const result = ledger.snapshot(3000)
  assert.deepEqual(result.apps, [['foot', 3000]])
  assert.deepEqual(result.terminals, [
    { app: 'foot', executable: 'zsh', reason: null, ms: 2000 },
    { app: 'foot', executable: 'nvim', reason: null, ms: 1000 },
  ])
  assert.ok(!JSON.stringify(result).includes('foregroundPid'))
  assert.deepEqual(result.details, []) // --foot does not implicitly opt in to titles
})

test('focus change during scan discards old-window result; IPC failure clears context', () => {
  let calls = 0
  const other = { ...window, id: 2, info: { ...window.info, processId: 500 } }
  const ledger = new Accounting(0)
  let now = 0
  const native = { activeWindow: () => ++calls === 1 ? window : other, openWindows: () => [window, other] }
  const observer = new FootObserver({ native, ledger, clock: () => now, enabled: true,
    resolver: () => ({ status: 'resolved', executable: 'wrong-old-window' }) })
  observer.poll()
  assert.equal(ledger.snapshot(100).terminals[0].executable, null)
  now = 100
  native.activeWindow = () => { throw new Error('Synthetic disconnect') }
  assert.equal(observer.poll(), false)
  assert.equal(ledger.state().kind, 'IPC unavailable')
  assert.equal(ledger.snapshot(200).terminals.reduce((sum, row) => sum + row.ms, 0), 100)
})

test('disabled and paused enrichment performs no native queries or proc work', () => {
  let calls = 0
  const native = { activeWindow: () => { calls++; throw new Error('must not query') } }
  const ledger = new Accounting(0)
  const disabled = new FootObserver({ native, ledger, clock: () => 0 })
  disabled.observe(window); disabled.poll()
  assert.equal(calls, 0)
  assert.deepEqual(ledger.snapshot(100).terminals, [])
  ledger.togglePause(100)
  const paused = new FootObserver({ native, ledger, clock: () => 100, enabled: true })
  paused.poll()
  assert.equal(calls, 0)
})

test('CLI foot polling runs without title events and survives checkpoint/HTML export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-foot-cli-'))
  try {
    const fixture = join(dir, 'native.cjs')
    const calls = join(dir, 'calls.txt')
    const state = join(dir, 'session.json')
    const html = join(dir, 'report.html')
    writeFileSync(fixture, `
      let calls = 0;
      const w = {id:1,info:{name:'foot',execName:'foot',processId:2147483647},title:'SYNTHETIC_TITLE_NOT_OPTED_IN'};
      exports.activeWindow = () => { calls++; return w; };
      exports.openWindows = () => [w];
      exports.subscribeActiveWindow = () => 1; // no title/focus callbacks at all
      exports.unsubscribeActiveWindow = () => require('node:fs').writeFileSync(${JSON.stringify(calls)}, String(calls));
    `)
    const args = [join(__dirname, 'tracker.cjs'), '--native', fixture, '--state', state, '--foot', '--foot-interval', '500', '--duration', '0.65', '--json', '--html', html]
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 3000 })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.footEnabled, true)
    assert.ok(report.terminals.some((row) => row.reason === 'process-exited' && row.ms > 0))
    assert.ok(Number(readFileSync(calls, 'utf8')) >= 5)
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).footEnabled, true)
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).version, 2)
    assert.match(readFileSync(html, 'utf8'), /Unknown — process-exited/)
    assert.ok(!result.stdout.includes('SYNTHETIC_TITLE_NOT_OPTED_IN'))
    assert.ok(!readFileSync(state, 'utf8').includes('SYNTHETIC_TITLE_NOT_OPTED_IN'))
    const mismatch = spawnSync(process.execPath, args.filter((arg) => arg !== '--foot'), { encoding: 'utf8', timeout: 2000 })
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /foot policy differs/)
    // Upgrade a prior title-enabled v2 history without inventing past labels.
    const namedState = join(dir, 'named.json')
    const old = JSON.parse(readFileSync(state, 'utf8'))
    old.titlesEnabled = true
    writeFileSync(namedState, JSON.stringify(old), { mode: 0o600 })
    const named = spawnSync(process.execPath, [join(__dirname, 'tracker.cjs'), '--native', fixture,
      '--state', namedState, '--foot', '--titles', '--duration', '0.12', '--json'], { encoding: 'utf8', timeout: 3000 })
    assert.equal(named.status, 0, named.stderr)
    const upgraded = JSON.parse(readFileSync(namedState, 'utf8'))
    assert.equal(upgraded.version, 3)
    assert.ok(upgraded.snapshot.elapsedMs > old.snapshot.elapsedMs)
    assert.deepEqual(upgraded.snapshot.agentLabels, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('terminal checkpoint rows are validated, restored, and HTML-escaped', () => {
  const ledger = new Accounting(0)
  ledger.observe('foot', 0, null, { status: 'resolved', executable: '<script>bad</script>' })
  const snapshot = ledger.snapshot(1000)
  const record = { version: 2, startedAt: '2026-01-01', errors: 0, titlesEnabled: false, footEnabled: true, snapshot }
  validate(record, false, true)
  assert.throws(() => validate(record, false, false), /foot policy/)
  const restored = new Accounting(5000, snapshot)
  assert.deepEqual(restored.snapshot(5000).terminals, snapshot.terminals)
  const html = renderHtml({ ...snapshot, footEnabled: true })
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  snapshot.terminals[0].ms = 9999
  assert.throws(() => validate(record, false, true), /Invalid checkpoint/)
})
