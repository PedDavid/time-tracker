'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const net = require('node:net')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { Accounting } = require('./accounting.cjs')
const { FootObserver } = require('./foot-observer.cjs')
const { ActivityProvider, ActivityGate, activityMetadata } = require('./activity.cjs')
const { socketPath, request, validateVersion, lockState } = require('./activity-hyprland.cjs')
const { validate } = require('./checkpoint.cjs')

const record = (snapshot) => ({ version: 3, startedAt: '2026-01-01', errors: 0, titlesEnabled: true, footEnabled: true,
  activityDetection: activityMetadata(true, 1000), snapshot })
const settled = () => new Promise((resolve) => setImmediate(resolve))
const version = { tag: 'v0.56.2', commit: 'efb50993780079460b0cbed1363e2166a2de1d9f', dirty: false }

function fixture() {
  let now = 0, executable = 'pi', title = 'Synthetic A', focusCalls = 0, procCalls = 0
  const ledger = new Accounting(0)
  const window = { id: 1, info: { name: 'foot', execName: 'foot', processId: 100 }, get title() { return title } }
  const native = { activeWindow: () => { focusCalls++; return window }, openWindows: () => [window] }
  const observer = new FootObserver({ native, ledger, clock: () => now, titles: true, enabled: true,
    resolver: () => { procCalls++; return { status: 'resolved', executable } } })
  const gate = new ActivityGate({ ledger, observer, native, clock: () => now })
  return { ledger, window, observer, gate, now: (value) => { now = value }, change: () => { executable = 'claude'; title = 'Synthetic B' },
    calls: () => ({ focusCalls, procCalls }) }
}

test('active → idle → active clears old focus, title, terminal and agent label; exact totals', () => {
  const f = fixture()
  f.gate.signal({ kind: 'activity-unavailable' })
  f.now(100); f.gate.signal({ kind: 'active' })
  f.now(1000); f.gate.signal({ kind: 'idle' })
  assert.equal(f.ledger.focusTerminal, null)
  assert.equal(f.observer.context, null)
  assert.equal(f.observer.identity, null)
  // A queued observation cannot restore attributable focus while gated.
  f.now(1100); f.ledger.observe('stale', 1100, 'stale', { status: 'resolved', executable: 'stale' })
  assert.equal(f.ledger.focus, null)
  f.change(); f.now(2000); f.gate.signal({ kind: 'active' })
  const report = f.ledger.snapshot(3000)
  assert.deepEqual(report.apps, [['foot', 1900]])
  assert.deepEqual(report.excluded, [['activity-unavailable', 100], ['idle', 1000]])
  assert.deepEqual(report.agentLabels.map((r) => [r.executable, r.label, r.ms]), [['claude', 'Synthetic B', 1000], ['pi', 'Synthetic A', 900]])
  validate(record(report), true, true)
})

test('manual pause survives idle, lock, unlock, disconnect and checkpoint restart', () => {
  const f = fixture()
  f.gate.refresh()
  f.now(1000); f.ledger.togglePause(1000)
  f.now(1500); f.gate.signal({ kind: 'idle' })
  f.now(2000); f.gate.signal({ kind: 'locked' })
  f.now(2500); f.gate.signal({ kind: 'activity-unavailable' })
  f.change(); f.now(3000); f.gate.signal({ kind: 'active' })
  assert.equal(f.ledger.state().kind, 'paused')
  assert.equal(f.calls().procCalls, 1) // No proc scans on activity restoration while paused.
  const saved = f.ledger.snapshot(4000)
  validate(record(saved), true, true)
  const restored = new Accounting(1000000, saved)
  assert.equal(restored.paused, true)
  assert.equal(restored.focus, null)
  assert.equal(restored.focusTerminal, null)
  assert.equal(restored.snapshot(1000100).elapsedMs, 4100)
  f.now(4000); f.ledger.togglePause(4000); f.gate.refresh()
  const report = f.ledger.snapshot(5000)
  assert.deepEqual(report.excluded, [['paused', 3000]])
  assert.equal(report.trackedMs, 2000)
  assert.deepEqual(report.terminals.map((r) => r.executable).sort(), ['claude', 'pi'])
})

test('lock/unlock and scheduling gaps exclude exactly and require fresh observations', () => {
  const f = fixture()
  f.gate.refresh()
  f.now(1000); f.gate.signal({ kind: 'locked' })
  f.now(2000); f.gate.signal({ kind: 'active' })
  f.ledger.snapshot(3000)
  f.now(10000); f.gate.signal({ kind: 'activity-unavailable', gap: true })
  assert.equal(f.ledger.snapshot(10000).trackedMs, 2000)
  f.now(11000); f.gate.signal({ kind: 'active' })
  const s = f.ledger.snapshot(12000)
  assert.deepEqual(s.excluded, [['locked', 1000], ['activity-unavailable', 8000]])
  assert.equal(s.trackedMs, 3000)
  assert.equal(s.elapsedMs, 12000)
})

test('schema and version capability fail closed, including workspace-only monitors and missing fields', () => {
  assert.equal(validateVersion(version), true)
  for (const value of [null, {}, { tag: 'v0.56.3' }, { tag: 'v0.55.0' }, { ...version, dirty: true }, { ...version, commit: 'unreviewed' }]) assert.throws(() => validateVersion(value))
  assert.equal(lockState([{ solitaryBlockedBy: ['WINDOWED', 'CANDIDATE'] }]), 'unlocked')
  assert.equal(lockState([{ solitaryBlockedBy: null }]), 'unlocked')
  assert.equal(lockState([{ solitaryBlockedBy: ['WORKSPACE'] }, { solitaryBlockedBy: ['LOCK'] }]), 'locked')
  for (const value of [[], null, [{}], [{ solitaryBlockedBy: 'LOCK' }], [{ solitaryBlockedBy: ['WORKSPACE'] }], [{ solitaryBlockedBy: ['NEW'] }], [{ solitaryBlockedBy: ['LOCK', 'LOCK'] }]]) assert.throws(() => lockState(value))
  assert.equal(socketPath({ XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: 'test_1' }), '/run/user/1000/hypr/test_1/.socket.sock')
  for (const signature of ['.', '..', '../x', '/x', '']) assert.throws(() => socketPath({ XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: signature }))
})

function providerFixture() {
  let now = 0, wall = 0, blockers = [], queryError = false, cleanup = 0
  const children = [], signals = []
  const provider = new ActivityProvider({ clock: () => now, wall: () => wall, path: '/mock', interval: () => 1, clear: () => { cleanup++ },
    request: async (_, command) => {
      if (queryError) throw new Error('mock disconnect')
      return command === 'j/version' ? version : [{ solitaryBlockedBy: blockers }]
    },
    spawnHelper: () => {
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough()
      child.killed = []
      child.kill = (signal) => { child.killed.push(signal); queueMicrotask(() => child.emit('close')); return true }
      children.push(child); return child
    } })
  provider.start((signal) => signals.push(signal))
  const output = (kind, child = children.at(-1)) => child.stdout.write(JSON.stringify({ version: 1, kind }) + '\n')
  return { provider, children, signals, output, time: (value, real = value) => { now = value; wall = real },
    blockers: (value) => { blockers = value }, fail: () => { queryError = true }, cleanup: () => cleanup }
}

test('mock provider startup, signals, compositor lock precedence and errors never retain stale activity', async () => {
  const f = providerFixture()
  try {
    await settled()
    assert.equal(f.provider.kind, 'activity-unavailable')
    f.output('active'); assert.equal(f.provider.kind, 'active')
    f.time(500); f.output('idle'); assert.equal(f.provider.kind, 'idle')
    f.blockers(['LOCK']); f.provider.tick(); await settled()
    assert.equal(f.provider.kind, 'locked')
    f.output('active'); assert.equal(f.provider.kind, 'locked')
    f.blockers([]); f.time(1000); f.provider.tick(); await settled()
    assert.equal(f.provider.kind, 'active')
    f.fail(); f.time(1500); f.provider.tick(); await settled()
    assert.equal(f.provider.kind, 'activity-unavailable')
  } finally { f.provider.close(); await settled() }
  assert.equal(f.cleanup(), 1)
  assert.deepEqual(f.children[0].killed, ['SIGTERM'])
})

test('helper expiry/disconnect/malformed data and cancellation clean up without late callbacks', async () => {
  const f = providerFixture()
  await settled(); f.output('active')
  f.time(1600); f.provider.checkHealth()
  assert.equal(f.provider.kind, 'activity-unavailable')
  f.output('idle'); assert.equal(f.provider.kind, 'activity-unavailable') // lock also expired
  f.children[0].stdout.write('not json\n')
  assert.deepEqual(f.children[0].killed, ['SIGTERM'])
  await settled()
  const count = f.signals.length
  f.provider.close(); f.output('active')
  f.provider.tick(); await settled()
  assert.equal(f.signals.length, count)
  assert.equal(f.children.length, 1)
})

test('suspend/clock skew clears both signals, cancels helper, and marks gap before queued focus', async () => {
  const f = providerFixture()
  try {
    await settled(); f.output('active')
    f.time(100, 60000)
    assert.equal(f.provider.checkHealth(), false)
    assert.equal(f.signals.at(-1).gap, true)
    assert.equal(f.provider.kind, 'activity-unavailable')
    assert.deepEqual(f.children[0].killed, ['SIGTERM'])
    f.output('active') // Old queued output must not resurrect it.
    assert.equal(f.provider.kind, 'activity-unavailable')
  } finally { f.provider.close(); await settled() }
})

test('unsupported startup and spawn errors remain unavailable; retries and close are safe', async () => {
  let now = 0, launches = 0
  const signals = []
  const provider = new ActivityProvider({ clock: () => now, wall: () => now, interval: () => 1, clear: () => {},
    path: () => { throw new Error('No session') }, spawnHelper: () => { launches++; throw new Error('No executable') } })
  provider.start((signal) => signals.push(signal))
  await settled()
  provider.tick(); assert.equal(launches, 1)
  now = 1000; provider.tick(); await settled()
  assert.equal(launches, 2)
  assert.equal(provider.kind, 'activity-unavailable')
  provider.close(); provider.close()
  assert.equal(signals.some((s) => s.kind === 'active'), false)
})

test('provider shutdown cancels pending IPC and force-cleans a resistant helper', async () => {
  let aborted = false
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.killed = []
  child.kill = (signal) => {
    child.killed.push(signal)
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close'))
    return true
  }
  const provider = new ActivityProvider({ clock: () => 0, wall: () => 0, interval: () => 1, clear: () => {}, path: '/mock',
    spawnHelper: () => child,
    request: (_, __, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('Cancelled')) }, { once: true })
    }) })
  provider.start(() => {})
  provider.close()
  assert.equal(aborted, true)
  await once(child, 'close')
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL'])
  assert.equal(provider.children.size, 0)
  assert.equal(provider.pending, false)
})

test('bounded direct Unix IPC: valid, oversized, malformed, timeout, cancellation', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'activity-ipc-'))
  const path = join(dir, 'socket')
  let mode = 'valid'
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('data', (command) => {
      assert.equal(command.toString(), 'j/monitors')
      if (mode === 'valid') socket.end('[{"solitaryBlockedBy":null}]')
      if (mode === 'large') socket.end('x'.repeat(1025))
      if (mode === 'bad') socket.end('not-json')
    })
  })
  server.listen(path); await once(server, 'listening')
  try {
    assert.equal(lockState(await request(path, 'j/monitors')), 'unlocked')
    mode = 'large'; await assert.rejects(request(path, 'j/monitors', { maxBytes: 1024 }), /too large/)
    mode = 'bad'; await assert.rejects(request(path, 'j/monitors'), /JSON/)
    mode = 'hang'; await assert.rejects(request(path, 'j/monitors', { timeout: 10 }), /timeout/)
    const abort = new AbortController()
    const pending = request(path, 'j/monitors', { signal: abort.signal })
    abort.abort(); await assert.rejects(pending, /Cancelled/)
    await assert.rejects(request(path, 'dispatch exit'), /read-only/)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('checkpoint metadata is validated; old versions load and disabled policy is explicit', () => {
  const f = fixture(); f.gate.refresh()
  const s = f.ledger.snapshot(1000)
  validate(record(s), true, true)
  for (const change of [{ lockSource: 'logind' }, { lockScope: 'all-wayland' }, { idleTimeoutMs: 0 }, { enabled: 'yes' }]) {
    assert.throws(() => validate({ ...record(s), activityDetection: { ...activityMetadata(true, 1000), ...change } }, true, true), /Invalid checkpoint/)
  }
  const disabled = { ...record(s), activityDetection: activityMetadata(false, 1000) }
  validate(disabled, true, true)
  for (const version of [1, 2, 3]) {
    const old = { ...record(s), version, footEnabled: version >= 2 }
    delete old.activityDetection
    old.snapshot = { ...s, terminals: [], agentLabels: [] }
    delete old.snapshot.activity; delete old.snapshot.manualPaused
    validate(old, true, version >= 2)
  }
  assert.throws(() => validate({ ...record(s), snapshot: { ...s, manualPaused: true } }, true, true), /Invalid checkpoint/)
})

test('CLI default unavailable excludes time and persists metadata without any desktop', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'activity-cli-'))
  try {
    const native = join(dir, 'native.cjs'), state = join(dir, 'state.json')
    fs.writeFileSync(native, `exports.activeWindow=()=>({id:1,info:{name:'fixture.Editor'},title:'PRIVATE'});exports.subscribeActiveWindow=()=>1;exports.unsubscribeActiveWindow=()=>{};`)
    const args = [join(__dirname, 'tracker.cjs'), '--native', native, '--state', state, '--activity-helper', join(dir, 'missing'), '--duration', '0.1', '--json']
    const env = { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: '' } // Never query a live desktop in this CLI test.
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 3000, env })
    assert.equal(result.status, 0, result.stderr)
    const s = JSON.parse(result.stdout)
    assert.equal(s.trackedMs, 0)
    assert.equal(s.state.kind, 'activity-unavailable')
    assert.equal(s.activityDetection.enabled, true)
    assert.equal(s.idleDetection, true)
    assert.ok(!result.stdout.includes('PRIVATE'))
    const saved = JSON.parse(fs.readFileSync(state))
    validate(saved, false, false)
    assert.equal(saved.activityDetection.lockSource, 'hyprland-monitors-solitary')
    const disabled = spawnSync(process.execPath, [...args, '--no-activity'], { encoding: 'utf8', timeout: 3000, env })
    assert.equal(disabled.status, 0, disabled.stderr)
    const resumed = JSON.parse(disabled.stdout)
    assert.equal(resumed.activityDetection.enabled, false)
    assert.equal(resumed.lockDetection, false)
    assert.equal(resumed.activityDetection.historyComplete, false)
    const enabledAgain = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 3000, env })
    assert.equal(enabledAgain.status, 0, enabledAgain.stderr)
    assert.equal(JSON.parse(enabledAgain.stdout).activityDetection.historyComplete, false)
    assert.ok(resumed.trackedMs > 0)
    assert.ok(resumed.elapsedMs < 1000)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
