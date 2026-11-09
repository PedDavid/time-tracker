'use strict'

const fs = require('node:fs')
const { dirname, basename, join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const MAX_BYTES = 16 * 1024 * 1024
const finite = (value) => Number.isFinite(value) && value >= 0

function validate(record, titlesEnabled, footEnabled = false) {
  const fail = () => { throw new Error('Invalid checkpoint; preserved without overwriting. Choose another --state path or restore a backup.') }
  if (!record || ![1, 2, 3].includes(record.version) || typeof record.titlesEnabled !== 'boolean' ||
      !Number.isFinite(Date.parse(record.startedAt)) || !Number.isSafeInteger(record.errors) || record.errors < 0) fail()
  if (record.titlesEnabled !== titlesEnabled) {
    throw new Error('Checkpoint title policy differs. Use the same --titles setting or choose a new --state path; existing history is preserved.')
  }
  if (record.footEnabled !== undefined && typeof record.footEnabled !== 'boolean') fail()
  if ((record.version >= 2) !== Boolean(record.footEnabled)) fail()
  if (record.version === 3 && !record.titlesEnabled) fail()
  if (Boolean(record.footEnabled) !== footEnabled) {
    throw new Error('Checkpoint foot policy differs. Use the same --foot setting or choose a new --state path; existing history is preserved.')
  }
  const s = record.snapshot
  if (!s || !finite(s.elapsedMs) || !finite(s.trackedMs) || !Array.isArray(s.details) ||
      !s.state || !['waiting', 'tracking', 'paused', 'no focus', 'IPC unavailable', 'idle', 'locked', 'activity-unavailable'].includes(s.state.kind)) fail()
  const activityKinds = ['active', 'idle', 'locked', 'activity-unavailable']
  if (s.manualPaused !== undefined && (typeof s.manualPaused !== 'boolean' || s.manualPaused !== (s.state.kind === 'paused'))) fail()
  if (s.activity !== undefined && (!activityKinds.includes(s.activity) ||
      (s.state.kind !== 'paused' && (s.activity === 'active' ? activityKinds.slice(1).includes(s.state.kind) : s.state.kind !== s.activity)))) fail()
  if (record.activityDetection !== undefined) {
    const a = record.activityDetection
    if (!a || typeof a.enabled !== 'boolean' || !Number.isInteger(a.idleTimeoutMs) || a.idleTimeoutMs < 1000 || a.idleTimeoutMs > 86400000 ||
        a.idleSource !== 'ext-idle-notify-v2-input' || a.lockSource !== 'hyprland-monitors-solitary' || a.lockScope !== 'hyprland-0.56.2-polled') fail()
    if (s.manualPaused === undefined || s.activity === undefined ||
        (a.historyComplete !== undefined && (typeof a.historyComplete !== 'boolean' || (a.historyComplete && !a.enabled))) ||
        (!a.enabled && s.activity !== 'active')) fail()
  }
  const pairs = (rows, maxLength) => {
    if (!Array.isArray(rows)) fail()
    const seen = new Set()
    let total = 0
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0] ||
          row[0].length > maxLength || /[\p{C}\p{Zl}\p{Zp}]/u.test(row[0]) || !finite(row[1]) || seen.has(row[0])) fail()
      seen.add(row[0]); total += row[1]
    }
    return total
  }
  const tracked = pairs(s.apps, 80)
  const excluded = pairs(s.excluded, 80)
  if (s.excluded.some(([kind]) => !['waiting', 'paused', 'no focus', 'IPC unavailable', 'idle', 'locked', 'activity-unavailable'].includes(kind))) fail()
  if (s.state.kind === 'tracking' && (typeof s.state.app !== 'string' || !s.state.app || s.state.app.length > 80 || /[\p{C}\p{Zl}\p{Zp}]/u.test(s.state.app))) fail()
  if (!finite(tracked) || !finite(excluded) || Math.abs(tracked - s.trackedMs) > 1 || Math.abs(tracked + excluded - s.elapsedMs) > 1) fail()
  const apps = new Map(s.apps)
  const detailTotals = new Map()
  const seen = new Set()
  for (const detail of s.details) {
    if (!detail || !apps.has(detail.app) || typeof detail.title !== 'string' || !detail.title ||
        detail.title.length > 240 || /[\p{C}\p{Zl}\p{Zp}]/u.test(detail.title) || !finite(detail.ms)) fail()
    const key = JSON.stringify([detail.app, detail.title])
    if (seen.has(key)) fail()
    seen.add(key)
    detailTotals.set(detail.app, (detailTotals.get(detail.app) || 0) + detail.ms)
  }
  if (!titlesEnabled && s.details.length) fail()
  for (const [app, total] of detailTotals) if (!finite(total) || total > apps.get(app) + 1) fail()
  const terminals = s.terminals === undefined ? [] : s.terminals
  if (!Array.isArray(terminals) || (!footEnabled && terminals.length)) fail()
  const terminalTotals = new Map()
  const terminalKeys = new Set()
  const executableTotals = new Map()
  for (const row of terminals) {
    if (!row || !apps.has(row.app) || !finite(row.ms)) fail()
    const resolved = typeof row.executable === 'string' && row.executable.length > 0 && row.executable.length <= 80 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(row.executable) && row.reason === null
    const unknown = row.executable === null && typeof row.reason === 'string' && /^[a-z0-9-]{1,80}$/.test(row.reason)
    if (!resolved && !unknown) fail()
    const key = JSON.stringify([row.app, row.executable, row.reason])
    if (terminalKeys.has(key)) fail()
    terminalKeys.add(key)
    terminalTotals.set(row.app, (terminalTotals.get(row.app) || 0) + row.ms)
    if (resolved) {
      const key = JSON.stringify([row.app, row.executable])
      executableTotals.set(key, (executableTotals.get(key) || 0) + row.ms)
    }
  }
  for (const [app, total] of terminalTotals) if (!finite(total) || total > apps.get(app) + 1) fail()
  const labels = s.agentLabels === undefined ? [] : s.agentLabels
  if (!Array.isArray(labels) || (labels.length && (!titlesEnabled || !footEnabled || record.version < 3))) fail()
  const labelKeys = new Set()
  const perExecutable = new Map()
  const perTitle = new Map()
  const titleTimes = new Map(s.details.map((row) => [JSON.stringify([row.app, row.title]), row.ms]))
  for (const row of labels) {
    if (!row || !apps.has(row.app) || !['pi', 'claude'].includes(row.executable) || row.source !== 'window-title' ||
        typeof row.label !== 'string' || !row.label || row.label.length > 240 || /[\p{C}\p{Zl}\p{Zp}]/u.test(row.label) || !finite(row.ms)) fail()
    const key = JSON.stringify([row.app, row.executable, row.label])
    if (labelKeys.has(key)) fail()
    labelKeys.add(key)
    for (const [map, key] of [[perExecutable, JSON.stringify([row.app, row.executable])], [perTitle, JSON.stringify([row.app, row.label])]]) map.set(key, (map.get(key) || 0) + row.ms)
  }
  for (const [map, totals] of [[perExecutable, executableTotals], [perTitle, titleTimes]]) {
    for (const [key, total] of map) if (!finite(total) || !totals.has(key) || total > totals.get(key) + 1) fail()
  }
  return record
}

function ownedFile(fd) {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Checkpoint/lock must be a regular file owned by this user')
  fs.fchmodSync(fd, 0o600)
  return stat
}

class Checkpoint {
  constructor(path, titlesEnabled, footEnabled = false) {
    this.path = path
    this.titlesEnabled = titlesEnabled
    this.footEnabled = footEnabled
    this.fd = null
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      this.fd = fs.openSync(`${path}.lock`, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
      ownedFile(this.fd)
      // Linux flock locks the shared open-file description, not the helper PID.
      // FD 3 in this one startup helper shares our open description. The lock
      // remains held by this process, and the kernel releases it even on SIGKILL.
      // Never unlink the lockfile: doing so could let another writer bypass it.
      const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
        stdio: ['ignore', 'pipe', 'pipe', this.fd], timeout: 3000,
      })
      if (result.error) throw new Error('Checkpoint locking requires the existing Linux flock command; use --no-state for an ephemeral run')
      if (result.status === 73) throw new Error('Another tracker holds this checkpoint. Choose a different --state path.')
      if (result.status !== 0) throw new Error('Could not lock checkpoint')
      this.record = this.load()
    } catch (error) { this.close(); throw error }
  }

  load() {
    let fd
    try {
      fd = fs.openSync(this.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const stat = ownedFile(fd)
      if (stat.size > MAX_BYTES) throw new Error('Checkpoint is too large; preserved without overwriting')
      return validate(JSON.parse(fs.readFileSync(fd, 'utf8')), this.titlesEnabled, this.footEnabled)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      if (error instanceof SyntaxError) throw new Error('Checkpoint contains malformed JSON; preserved without overwriting')
      throw error
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }

  save(record) {
    if (this.fd === null) throw new Error('Checkpoint is closed')
    validate(record, this.titlesEnabled, this.footEnabled)
    const content = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Checkpoint exceeds 16 MiB; previous checkpoint preserved')
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`)
    let fd
    try {
      fd = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(fd, content, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd); fd = undefined
      fs.renameSync(temporary, this.path)
      const directory = fs.openSync(dirname(this.path), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null }
  }
}

module.exports = { Checkpoint, validate }
