'use strict'

const fs = require('node:fs')
const { dirname, basename, join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const MAX_BYTES = 16 * 1024 * 1024
const finite = (value) => Number.isFinite(value) && value >= 0

function validate(record, titlesEnabled) {
  const fail = () => { throw new Error('Invalid checkpoint; preserved without overwriting. Choose another --state path or restore a backup.') }
  if (!record || record.version !== 1 || typeof record.titlesEnabled !== 'boolean' ||
      !Number.isFinite(Date.parse(record.startedAt)) || !Number.isSafeInteger(record.errors) || record.errors < 0) fail()
  if (record.titlesEnabled !== titlesEnabled) {
    throw new Error('Checkpoint title policy differs. Use the same --titles setting or choose a new --state path; existing history is preserved.')
  }
  const s = record.snapshot
  if (!s || !finite(s.elapsedMs) || !finite(s.trackedMs) || !Array.isArray(s.details) ||
      !s.state || !['waiting', 'tracking', 'paused', 'no focus', 'IPC unavailable'].includes(s.state.kind)) fail()
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
  return record
}

function ownedFile(fd) {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Checkpoint/lock must be a regular file owned by this user')
  fs.fchmodSync(fd, 0o600)
  return stat
}

class Checkpoint {
  constructor(path, titlesEnabled) {
    this.path = path
    this.titlesEnabled = titlesEnabled
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
      return validate(JSON.parse(fs.readFileSync(fd, 'utf8')), this.titlesEnabled)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      if (error instanceof SyntaxError) throw new Error('Checkpoint contains malformed JSON; preserved without overwriting')
      throw error
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }

  save(record) {
    if (this.fd === null) throw new Error('Checkpoint is closed')
    validate(record, this.titlesEnabled)
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
