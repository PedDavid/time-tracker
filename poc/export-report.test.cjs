'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const { readCheckpoint, MAX_BYTES } = require('./checkpoint-reader.cjs')
const { Checkpoint } = require('./checkpoint.cjs')

const cli = join(__dirname, 'export-report.cjs')
const stamp = '2026-01-01T00:00:05.000Z'
const privateTitle = 'Synthetic <script>alert("label")</script> & task'

function record(version = 1, titles = false, ms = 5000) {
  const app = 'fixture.foot'
  return {
    version, startedAt: '2026-01-01T00:00:00.000Z', savedAt: stamp,
    titlesEnabled: titles, footEnabled: version >= 2, errors: 0,
    snapshot: {
      elapsedMs: ms + 1000, trackedMs: ms, apps: [[app, ms]], excluded: [['paused', 1000]],
      details: titles ? [{ app, title: privateTitle, ms }] : [],
      terminals: version >= 2 ? [{ app, executable: 'pi', reason: null, ms }] : [],
      agentLabels: version === 3 ? [{ app, executable: 'pi', source: 'window-title', label: privateTitle, ms }] : [],
      state: { kind: 'tracking', app },
    },
  }
}
function directory(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'focus-export-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function save(path, value = record()) {
  fs.writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 })
}
function run(state, html, flags = [], extra = {}) {
  return spawnSync(process.execPath, [cli, '--state', state, '--html', html, ...flags], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, PATH: '' }, ...extra,
  })
}
function identity(path) {
  const stat = fs.statSync(path, { bigint: true })
  return { bytes: fs.readFileSync(path), ino: stat.ino, mode: stat.mode, uid: stat.uid, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}
function failure(result, pattern) {
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, pattern)
  assert.equal(result.stdout, '')
  assert.ok(!result.stderr.includes(privateTitle), 'private title leaked in diagnostics')
}

test('offline export preserves saved totals, checkpoint bytes/metadata and directory contents', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const html = join(dir, 'report.html')
  save(state)
  const before = identity(state)
  const result = run(state, html)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /latest saved snapshot.*not a live query/)
  assert.deepEqual(identity(state), before)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['report.html', 'state.json'])
  assert.equal(fs.statSync(html).mode & 0o777, 0o600)
  const text = fs.readFileSync(html, 'utf8')
  assert.match(text, /Checkpoint as of/)
  assert.match(text, new RegExp(stamp.replaceAll('.', '\\.')))
  assert.match(text, /typically 5 seconds behind/)
  assert.match(text, /No time after this snapshot was added/)
  assert.match(text, /00:00:06/)
  assert.match(text, /00:00:05/)
  assert.doesNotMatch(text, /<script|<iframe|<link|https?:\/\//i)
  assert.equal(readCheckpoint(state).elapsedMs, 6000)
  assert.equal(readCheckpoint(state).trackedMs, 5000)
})

test('export uses no native addon, compositor, proc enrichment or flock invocation', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const html = join(dir, 'report.html')
  const guard = join(dir, 'guard.cjs')
  save(state, record(3, true))
  fs.writeFileSync(guard, `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (id, ...args) {
      if (/\\.node$|x-win|foot-observer|accounting/.test(id)) throw new Error('Forbidden live dependency');
      return original.call(this, id, ...args);
    };
    const cp = require('node:child_process');
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[key] = () => { throw new Error('Forbidden subprocess'); };
    const fs = require('node:fs');
    const read = fs.openSync;
    fs.openSync = (path, ...args) => {
      if (String(path).startsWith('/proc/') || String(path).endsWith('.lock')) throw new Error('Forbidden live/lock access');
      return read(path, ...args);
    };
    for (const key of ['mkdirSync', 'chmodSync', 'fchmodSync', 'unlinkSync', 'renameSync']) fs[key] = () => { throw new Error('Forbidden mutation'); };
  `)
  const result = spawnSync(process.execPath, ['--require', guard, cli, '--state', state, '--html', html, '--titles', '--foot'], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, PATH: '', DISPLAY: '', WAYLAND_DISPLAY: '', HYPRLAND_INSTANCE_SIGNATURE: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(fs.existsSync(html))
})

test('schema 1/2/3 export requires exact explicit title and foot consent; labels remain escaped', (t) => {
  const dir = directory(t)
  let sequence = 0
  for (const [version, titles] of [[1, false], [1, true], [2, false], [2, true], [3, true]]) {
    const state = join(dir, `state-${version}-${titles}.json`)
    save(state, record(version, titles))
    const before = identity(state)
    for (const requestedTitles of [false, true]) for (const requestedFoot of [false, true]) {
      const html = join(dir, `report-${sequence++}.html`)
      const flags = [...(requestedTitles ? ['--titles'] : []), ...(requestedFoot ? ['--foot'] : [])]
      const result = run(state, html, flags)
      if (requestedTitles !== titles || requestedFoot !== (version >= 2)) {
        failure(result, /policy differs/)
        assert.ok(!fs.existsSync(html))
      } else {
        assert.equal(result.status, 0, result.stderr)
        const text = fs.readFileSync(html, 'utf8')
        for (const section of ['Where your focus went', 'Window-title breakdown', 'foot foreground executables', 'Agent session labels', 'Time left out']) assert.ok(text.includes(section))
        assert.doesNotMatch(text, /<script>/)
        assert.equal(text.includes('&lt;script&gt;'), titles)
        if (version === 3) assert.match(text, /not verified session names or IDs/)
      }
      assert.deepEqual(identity(state), before)
    }
  }
})

test('old schema optional fields and missing saved-at use explicitly labelled file-mtime fallback', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const old = record()
  delete old.savedAt
  delete old.footEnabled
  delete old.snapshot.terminals
  delete old.snapshot.agentLabels
  save(state, old)
  fs.utimesSync(state, new Date(stamp), new Date(stamp))
  const report = readCheckpoint(state)
  assert.equal(report.checkpoint.asOf, stamp)
  assert.equal(report.checkpoint.timeSource, 'fileMtime')
  assert.equal(run(state, join(dir, 'report.html')).status, 0)
  assert.match(fs.readFileSync(join(dir, 'report.html'), 'utf8'), /file modification time; saved-at timestamp absent/)
})

test('missing, malformed, incompatible, invalid totals and invalid saved-at inputs fail without output', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const html = join(dir, 'report.html')
  failure(run(state, html), /Checkpoint is missing/)
  assert.deepEqual(fs.readdirSync(dir), [])
  for (const value of ['{ synthetic-private-title:', JSON.stringify(null), JSON.stringify({ ...record(), version: 99 }),
    JSON.stringify({ ...record(), savedAt: privateTitle }),
    JSON.stringify({ ...record(), snapshot: { ...record().snapshot, elapsedMs: 1 } })]) {
    fs.writeFileSync(state, value, { mode: 0o600 })
    const before = identity(state)
    failure(run(state, html), /malformed JSON|invalid or incompatible|timestamp is invalid/)
    assert.ok(!fs.existsSync(html))
    assert.deepEqual(identity(state), before)
  }
})

test('rejects oversized, public, symlink and nonregular checkpoints without changing them', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const html = join(dir, 'report.html')
  const fd = fs.openSync(state, 'wx', 0o600)
  fs.ftruncateSync(fd, MAX_BYTES + 1)
  fs.closeSync(fd)
  failure(run(state, html), /16 MiB/)
  assert.equal(fs.statSync(state).size, MAX_BYTES + 1)
  save(state)
  for (const mode of [0o640, 0o604, 0o666]) {
    fs.chmodSync(state, mode)
    const before = identity(state)
    failure(run(state, html), /permissions must be private/)
    assert.deepEqual(identity(state), before)
  }
  fs.chmodSync(state, 0o600)
  const link = join(dir, 'link.json')
  fs.symlinkSync(state, link)
  const before = identity(state)
  failure(run(link, html), /symlinks are not allowed/)
  assert.deepEqual(identity(state), before)
  failure(run(dir, html), /regular file/)
  assert.ok(!fs.existsSync(html))
})

test('a valid checkpoint exactly at 16 MiB is accepted, but one byte over is rejected', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const json = JSON.stringify(record())
  fs.writeFileSync(state, json + ' '.repeat(MAX_BYTES - Buffer.byteLength(json)), { mode: 0o600 })
  assert.equal(readCheckpoint(state).trackedMs, 5000)
  fs.appendFileSync(state, ' ')
  assert.throws(() => readCheckpoint(state), /16 MiB/)
})

test('a FIFO checkpoint is rejected promptly without a writer or output', (t) => {
  const dir = directory(t)
  const fifo = join(dir, 'fifo.json')
  const result = spawnSync('mkfifo', ['--mode=600', fifo], { encoding: 'utf8', timeout: 1000 })
  assert.equal(result.status, 0, result.stderr)
  const html = join(dir, 'report.html')
  failure(run(fifo, html), /regular file/)
  assert.ok(fs.lstatSync(fifo).isFIFO())
  assert.ok(!fs.existsSync(html))
})

test('ownership is checked on the opened fd and read budget cannot be bypassed by growth', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  save(state)
  const originalStat = fs.fstatSync
  try {
    fs.fstatSync = (...args) => ({ ...originalStat(...args), isFile: () => true, uid: process.getuid() + 1 })
    assert.throws(() => readCheckpoint(state), /owned by the current user/)
  } finally { fs.fstatSync = originalStat }
  const originalRead = fs.readSync
  let bytes = 0
  let grew = false
  try {
    fs.readSync = (...args) => {
      if (!grew) {
        grew = true
        fs.appendFileSync(state, Buffer.alloc(MAX_BYTES, 32))
      }
      const count = originalRead(...args)
      bytes += count
      return count
    }
    assert.throws(() => readCheckpoint(state), /16 MiB/)
    assert.equal(bytes, MAX_BYTES)
  } finally { fs.readSync = originalRead }
})

test('an atomic rename after open cannot mix old and new snapshot inodes', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const next = join(dir, 'next.json')
  save(state, record(1, false, 5000))
  save(next, record(1, false, 17000))
  const originalOpen = fs.openSync
  try {
    fs.openSync = (path, ...args) => {
      const fd = originalOpen(path, ...args)
      if (path === state) fs.renameSync(next, state)
      return fd
    }
    assert.equal(readCheckpoint(state).trackedMs, 5000)
  } finally { fs.openSync = originalOpen }
  assert.equal(readCheckpoint(state).trackedMs, 17000)
})

test('output existing file, symlinks, same checkpoint/lock and parent aliases are safe', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const html = join(dir, 'report.html')
  save(state)
  fs.writeFileSync(html, 'Synthetic existing report', { mode: 0o640 })
  const stateBefore = identity(state)
  const htmlBefore = identity(html)
  failure(run(state, html), /already exists/)
  assert.deepEqual(identity(html), htmlBefore)
  const link = join(dir, 'link.html')
  fs.symlinkSync(html, link)
  failure(run(state, link), /already exists|symlink/)
  assert.deepEqual(identity(html), htmlBefore)
  const dangling = join(dir, 'dangling.html')
  fs.symlinkSync(join(dir, 'absent.html'), dangling)
  failure(run(state, dangling), /already exists|symlink/)
  assert.ok(!fs.existsSync(join(dir, 'absent.html')))
  failure(run(state, state), /checkpoint and its lock path/)
  failure(run(state, `${state}.lock`), /checkpoint and its lock path/)
  assert.ok(!fs.existsSync(`${state}.lock`))
  const alias = join(dir, 'alias')
  fs.symlinkSync(dir, alias)
  failure(run(state, join(alias, 'state.json')), /checkpoint and its lock path/)
  failure(run(state, join(alias, 'state.json.lock')), /checkpoint and its lock path/)
  assert.deepEqual(identity(state), stateBefore)
  const missing = join(dir, 'missing-state.json')
  failure(run(missing, missing), /checkpoint and its lock path/)
  failure(run(missing, `${missing}.lock`), /checkpoint and its lock path/)
  assert.ok(!fs.existsSync(missing))
  assert.ok(!fs.existsSync(`${missing}.lock`))
})

test('unknown flags and invalid arguments cause no writes or private path echo, even with --help', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const html = join(dir, 'report.html')
  save(state)
  const before = identity(state)
  for (const flags of [['--unknown-synthetic-private-name'], ['--help', '--unknown'], ['--native', 'synthetic-private-name'], ['--state'], ['--html']]) {
    const result = run(state, html, flags)
    failure(result, /Unknown option|Missing path/)
    assert.doesNotMatch(result.stderr, /synthetic-private-name/)
    assert.ok(!fs.existsSync(html))
  }
  const result = spawnSync(process.execPath, [cli, '--state', state], { encoding: 'utf8' })
  failure(result, /--html NEWFILE is required/)
  assert.deepEqual(identity(state), before)
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

test('default XDG state path is read without creating directories', (t) => {
  const dir = directory(t)
  const stateDir = join(dir, 'focus-tracker')
  fs.mkdirSync(stateDir, { mode: 0o700 })
  const state = join(stateDir, 'session.json')
  save(state)
  const html = join(dir, 'report.html')
  const result = spawnSync(process.execPath, [cli, '--html', html], {
    encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: dir, PATH: '' }, timeout: 3000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(fs.readdirSync(stateDir), ['session.json'])
  const absent = join(dir, 'not-created')
  const missing = spawnSync(process.execPath, [cli, '--html', join(dir, 'missing.html')], {
    encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: absent, PATH: '' }, timeout: 3000,
  })
  failure(missing, /Checkpoint is missing/)
  assert.ok(!fs.existsSync(absent))
})

test('saved idle/lock metadata passes through unchanged and is injection-safe, not invented', (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const value = record()
  value.idleDetection = { enabled: true, source: '<script>synthetic</script>' }
  value.lockDetection = false
  value.snapshot.detection = { status: 'unknown' }
  save(state, value)
  const report = readCheckpoint(state)
  assert.deepEqual(report.idleDetection, value.idleDetection)
  assert.equal(report.lockDetection, false)
  assert.deepEqual(report.detection, value.snapshot.detection)
  const html = join(dir, 'report.html')
  assert.equal(run(state, html).status, 0)
  const text = fs.readFileSync(html, 'utf8')
  assert.match(text, /Saved idle\/lock detection metadata/)
  assert.match(text, /&lt;script&gt;synthetic&lt;\/script&gt;/)
  assert.doesNotMatch(text, /<script>|Idle and session lock are not detected/)
  save(state)
  const noMetadata = readCheckpoint(state)
  assert.equal(Object.hasOwn(noMetadata, 'idleDetection'), false)
  assert.equal(Object.hasOwn(noMetadata, 'lockDetection'), false)
})

test('export succeeds during a child writer flock and across successive atomic snapshots without lock changes', { timeout: 10000 }, async (t) => {
  const dir = directory(t)
  const state = join(dir, 'state.json')
  const child = spawn(process.execPath, ['-e', `
    const { Checkpoint } = require(${JSON.stringify(join(__dirname, 'checkpoint.cjs'))});
    const store = new Checkpoint(${JSON.stringify(state)}, false);
    const base = ${JSON.stringify(record())};
    store.save(base);
    process.send('ready');
    process.on('message', (message) => {
      if (message === 'next') {
        base.snapshot.elapsedMs += 7000;
        base.snapshot.trackedMs += 7000;
        base.snapshot.apps[0][1] += 7000;
        base.savedAt = '2026-01-01T00:00:12.000Z';
        store.save(base);
        process.send('saved');
      } else if (message === 'stop') { store.close(); process.exit(0); }
    });
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
  })
  assert.equal((await once(child, 'message'))[0], 'ready', stderr)
  assert.throws(() => new Checkpoint(state, false), /Another tracker/)
  const lockBefore = identity(`${state}.lock`)
  for (const [index, ms] of [[0, 5000], [1, 12000]]) {
    if (index) {
      const saved = once(child, 'message'); child.send('next'); assert.equal((await saved)[0], 'saved')
    }
    const before = identity(state)
    const html = join(dir, `report-${index}.html`)
    const result = run(state, html)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(identity(state), before)
    assert.deepEqual(identity(`${state}.lock`), lockBefore)
    assert.equal(readCheckpoint(state).trackedMs, ms)
    assert.match(fs.readFileSync(html, 'utf8'), new RegExp(index ? '00:00:12' : '00:00:05'))
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['report-0.html', 'report-1.html', 'state.json', 'state.json.lock'])
  const exited = once(child, 'exit'); child.send('stop'); await exited
})
