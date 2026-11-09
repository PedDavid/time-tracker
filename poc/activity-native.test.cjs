'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

// Optional transport-level test: no real display, input devices or native addon.
// Pure JS signal/accounting tests still run when development tools are absent.
test('C helper against synthetic Wayland server: transitions, missing/v1/multiple seats and disconnect', { timeout: 15000 }, (t) => {
  const available = spawnSync('pkg-config', ['--exists', 'wayland-client', 'wayland-server', 'wayland-protocols'])
  const compiler = process.env.CC || 'cc'
  if (available.status !== 0 || spawnSync(compiler, ['--version']).status !== 0 || spawnSync('wayland-scanner', ['--version']).status !== 0) {
    t.skip('Optional C transport tests require existing Wayland client/server development tools')
    return
  }
  const dir = fs.mkdtempSync(join(tmpdir(), 'activity-native-'))
  function run(program, args) {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 6000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    return result.stdout
  }
  try {
    const data = run('pkg-config', ['--variable=pkgdatadir', 'wayland-protocols']).trim()
    const xml = join(data, 'staging/ext-idle-notify/ext-idle-notify-v1.xml')
    run('wayland-scanner', ['client-header', xml, join(dir, 'activity-idle-protocol.h')])
    run('wayland-scanner', ['server-header', xml, join(dir, 'activity-idle-server-protocol.h')])
    const code = join(dir, 'protocol.c')
    run('wayland-scanner', ['private-code', xml, code])
    for (const [name, lib] of [['activity-idle', 'wayland-client'], ['activity-idle-mock', 'wayland-server']]) {
      const flags = run('pkg-config', ['--cflags', '--libs', lib]).trim().split(/\s+/).filter(Boolean)
      run(compiler, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-I', dir, join(__dirname, `${name}.c`), code, ...flags, '-o', join(dir, name)])
    }
    const execute = (mode) => run(join(dir, 'activity-idle-mock'), [join(dir, 'activity-idle'), mode]).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind)
    const kinds = execute('transitions').filter((kind, index, all) => kind !== all[index - 1])
    assert.deepEqual(kinds, ['activity-unavailable', 'active', 'idle', 'active', 'activity-unavailable'])
    for (const mode of ['no-seat', 'v1', 'multi-seat', 'disconnect', 'resume-without-idle', 'duplicate-idle']) {
      const states = execute(mode)
      assert.ok(states.length > 0)
      assert.equal(states.every((state) => state === 'activity-unavailable'), true, mode)
      if (mode === 'resume-without-idle' || mode === 'duplicate-idle') {
        assert.ok(states.length <= 3, `${mode}: protocol violations must stop the helper promptly`)
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
