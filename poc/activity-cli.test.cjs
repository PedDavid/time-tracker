'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')

// Every source is synthetic. This never connects to the real compositor or
// creates physical input, a desktop lock, or a Wayland surface.
test('CLI lock gates reject stale payloads and shutdown excludes a blocked event-loop gap', { timeout: 12000 }, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'fa-cli-'))
  const runtime = join(dir, 'hypr', 'fixture')
  fs.mkdirSync(runtime, { recursive: true })
  const state = join(dir, 'state.json')
  const focus = join(dir, 'focus.json')
  const event = join(dir, 'event.json')
  const ack = join(dir, 'ack.txt')
  const fixture = join(dir, 'native.cjs')
  const helper = join(dir, 'idle-fixture.cjs')
  const window = (name) => ({ id: 1, info: { name }, title: `${name} synthetic title` })
  const publish = (path, value) => {
    fs.writeFileSync(`${path}.next`, JSON.stringify(value))
    fs.renameSync(`${path}.next`, path)
  }
  fs.writeFileSync(focus, JSON.stringify(window('fixture.Before')))
  fs.writeFileSync(event, JSON.stringify({ sequence: 0 }))
  fs.writeFileSync(fixture, `
    const fs = require('node:fs'); let timer, seen = 0;
    exports.activeWindow = () => JSON.parse(fs.readFileSync(${JSON.stringify(focus)}, 'utf8'));
    exports.subscribeActiveWindow = callback => {
      timer = setInterval(() => {
        const event = JSON.parse(fs.readFileSync(${JSON.stringify(event)}, 'utf8'));
        if (event.sequence !== seen) {
          seen = event.sequence;
          if (event.block) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, event.block);
            // Exercise shutdown as the first callback after the stall, before
            // any queued health timer or helper message can repair the state.
            process.emit('SIGTERM'); return;
          }
          callback(null, event.window);
          fs.writeFileSync(${JSON.stringify(ack)}, String(seen));
        }
      }, 20);
      return 1;
    };
    exports.unsubscribeActiveWindow = () => clearInterval(timer);
  `)
  fs.writeFileSync(helper, `#!/usr/bin/env node
    setInterval(() => process.stdout.write('{"version":1,"kind":"active"}\\n'), 50);
  `, { mode: 0o700 })
  let locked = false
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', (data) => {
      const command = data.toString()
      if (command === 'j/version') socket.end(JSON.stringify({ tag: 'v0.56.2', commit: 'efb50993780079460b0cbed1363e2166a2de1d9f', dirty: false }))
      else if (command === 'j/monitors') socket.end(JSON.stringify([{ solitaryBlockedBy: locked ? ['LOCK'] : null }]))
      else socket.destroy()
    })
  })
  server.listen(join(runtime, '.socket.sock'))
  await once(server, 'listening')
  let child, closed, stdout = '', stderr = ''
  t.after(async () => {
    if (child) {
      const force = setTimeout(() => child.kill('SIGKILL'), 2000)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed
      clearTimeout(force)
    }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  child = spawn(process.execPath, [join(__dirname, 'tracker.cjs'), '--native', fixture, '--state', state,
    '--activity-helper', helper, '--titles', '--flush', '0.1', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
      XDG_RUNTIME_DIR: dir, HYPRLAND_INSTANCE_SIGNATURE: 'fixture', WAYLAND_DISPLAY: 'unused-synthetic-display' },
  })
  closed = once(child, 'close')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 4000
    for (;;) {
      let record
      try { record = JSON.parse(fs.readFileSync(state, 'utf8')) } catch {}
      if (predicate(record)) return record
      assert.equal(child.exitCode, null, stderr)
      assert.ok(Date.now() < deadline, `Synthetic tracker phase timed out: ${stderr}`)
      await sleep(20)
    }
  }
  const appTime = (record, name) => record?.snapshot.apps.find(([app]) => app === name)?.[1] || 0
  await waitFor((record) => appTime(record, 'fixture.Before') > 50)
  locked = true
  await waitFor((record) => record?.snapshot.activity === 'locked')
  publish(focus, window('fixture.After'))
  locked = false
  const restored = await waitFor((record) => record?.snapshot.activity === 'active' && appTime(record, 'fixture.After') > 50)
  publish(event, { sequence: 1, window: window('fixture.StaleBeforeLock') })
  await waitFor(() => fs.existsSync(ack))
  await waitFor((record) => appTime(record, 'fixture.After') > appTime(restored, 'fixture.After') + 100)
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'))
  const exported = { ...saved.snapshot, activityDetection: { ...saved.activityDetection, status: saved.snapshot.activity } }
  assert.equal(exported.activityDetection.enabled, true)
  assert.equal(exported.activityDetection.historyComplete, true)
  assert.equal(exported.activityDetection.status, 'active')
  assert.ok(exported.excluded.some(([kind, ms]) => kind === 'locked' && ms > 0))
  assert.ok(!exported.apps.some(([name]) => name.includes('StaleBeforeLock')))
  assert.ok(!exported.details.some(({ title }) => title.includes('StaleBeforeLock')))
  publish(event, { sequence: 2, block: 2500 })
  const [code] = await closed
  assert.equal(code, 0, stderr)
  const report = JSON.parse(stdout)
  assert.equal(report.errors, 0)
  assert.ok(report.trackedMs - exported.trackedMs < 500, 'Shutdown billed the scheduling gap to stale focus')
  assert.ok(report.excluded.some(([kind, ms]) => kind === 'activity-unavailable' && ms >= 2500))
  assert.ok(report.apps.some(([name, ms]) => name === 'fixture.After' && ms > 0))
  assert.ok(!stdout.includes('StaleBeforeLock'))
  assert.ok(Math.abs(report.trackedMs + report.excluded.reduce((sum, [, ms]) => sum + ms, 0) - report.elapsedMs) < 0.001)
})
