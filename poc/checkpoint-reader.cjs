'use strict'

const fs = require('node:fs')
const { validate } = require('./checkpoint.cjs')

const MAX_BYTES = 16 * 1024 * 1024

function checkFile(stat) {
  if (!stat.isFile()) throw new Error('Checkpoint must be a regular file.')
  if (!process.getuid || stat.uid !== process.getuid()) throw new Error('Checkpoint must be owned by the current user.')
  if (stat.mode & 0o077) throw new Error('Checkpoint permissions must be private (no group or other access); export will not change them.')
  if (stat.size > MAX_BYTES) throw new Error('Checkpoint exceeds the 16 MiB limit.')
}

// No Checkpoint instance: constructing one would acquire the writer lock and
// change permissions. An open fd pins one complete, atomically published inode
// even if the tracker renames the next snapshot over the path while we read.
function readCheckpoint(path, titlesEnabled = false, footEnabled = false) {
  if (typeof fs.constants.O_NOFOLLOW !== 'number') throw new Error('Safe checkpoint export requires filesystem O_NOFOLLOW support.')
  let fd
  let stat
  let text
  try {
    // NONBLOCK also prevents a hostile FIFO from blocking before fstat rejects it.
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    stat = fs.fstatSync(fd)
    checkFile(stat)
    const chunks = []
    let bytes = 0
    while (bytes < MAX_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES - bytes))
      const count = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (!count) break
      chunks.push(chunk.subarray(0, count))
      bytes += count
    }
    const after = fs.fstatSync(fd)
    checkFile(after)
    // Atomic-renaming writers never alter the opened inode. Refuse evident
    // in-place changes too, without reading more than the hard byte budget.
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytes !== after.size) {
      throw new Error('Checkpoint changed in place while reading; retry after an atomic save.')
    }
    text = Buffer.concat(chunks, bytes).toString('utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Checkpoint is missing; wait for a successful save or check --state.')
    if (error.code === 'ELOOP') throw new Error('Checkpoint symlinks are not allowed.')
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('Checkpoint cannot be read with current permissions.')
    if (error.code) throw new Error('Cannot open or read checkpoint; no state was changed.')
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }

  let record
  try { record = JSON.parse(text) } catch { throw new Error('Checkpoint contains malformed JSON; no state was changed.') }
  try { validate(record, titlesEnabled, footEnabled) } catch (error) {
    if (/title policy differs/.test(error.message)) throw new Error('Checkpoint title policy differs: match its --titles setting explicitly. No report was written.')
    if (/foot policy differs/.test(error.message)) throw new Error('Checkpoint foot policy differs: match its --foot setting explicitly. No report was written.')
    throw new Error('Checkpoint is invalid or incompatible (supported schemas: 1, 2, 3); no report was written.')
  }
  if (record.savedAt !== undefined && (typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt)))) {
    throw new Error('Checkpoint saved-at timestamp is invalid; no report was written.')
  }
  const report = {
    ...record.snapshot,
    startedAt: record.startedAt,
    errors: record.errors,
    titlesEnabled: record.titlesEnabled,
    footEnabled: Boolean(record.footEnabled),
    checkpoint: {
      asOf: new Date(record.savedAt === undefined ? stat.mtimeMs : record.savedAt).toISOString(),
      timeSource: record.savedAt === undefined ? 'fileMtime' : 'savedAt',
    },
  }
  // Current-run policy is validated by checkpoint.validate; combine only
  // saved fields, never the capabilities/activity of the export machine.
  if (record.activityDetection) {
    report.activityDetection = { ...record.activityDetection, status: record.snapshot.activity }
  }
  // Preserve legacy capability metadata without inventing missing values.
  for (const key of ['idleDetection', 'lockDetection', 'detection']) {
    if (Object.hasOwn(record, key)) report[key] = record[key]
  }
  return report
}

module.exports = { readCheckpoint, MAX_BYTES }
