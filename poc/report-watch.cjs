'use strict'

const fs = require('node:fs')
const { dirname, basename, join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { renderHtml } = require('./html-report.cjs')

const identity = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.nlink].join(':')
function changed() {
  const error = new Error('Watched HTML was removed, replaced, edited, or made unsafe; export stopped without overwriting it. Choose a new output filename.')
  error.code = 'REPORT_CHANGED'
  return error
}

// Claims a NEW output exclusively. Subsequent atomic replacements are allowed
// only while the path still identifies this writer's last private inode.
// As with checkpoints, parent directories must be trusted local directories;
// pathname checks plus rename are not an adversarial-directory sandbox.
class WatchedReport {
  constructor(path, report) {
    this.path = join(fs.realpathSync(dirname(path)), basename(path))
    this.html = renderHtml(report)
    const fd = fs.openSync(this.path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try {
      fs.writeFileSync(fd, this.html, 'utf8')
      fs.fsyncSync(fd)
      this.stamp = identity(fs.fstatSync(fd, { bigint: true }))
      this.assertOwned()
    } finally { fs.closeSync(fd) }
  }

  assertOwned() {
    let stat
    try { stat = fs.lstatSync(this.path, { bigint: true }) } catch { throw changed() }
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n ||
        stat.nlink !== 1n || identity(stat) !== this.stamp) throw changed()
  }

  update(report) {
    this.assertOwned()
    const html = renderHtml(report)
    if (html === this.html) return false
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`)
    let fd
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      fs.writeFileSync(fd, html, 'utf8')
      fs.fsyncSync(fd)
      this.assertOwned()
      fs.renameSync(temporary, this.path)
      this.stamp = identity(fs.fstatSync(fd, { bigint: true }))
      this.assertOwned()
      this.html = html
      return true
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd)
        try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
  }
}

function watchReport(config, report, { read, log = console.error } = {}) {
  let output
  try { output = new WatchedReport(config.html, report) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('HTML output already exists or is a symlink; watch mode must start with a new --html filename.')
    if (error.code === 'REPORT_CHANGED') throw error
    throw new Error('Could not create watched HTML output; choose a new filename in a trusted accessible directory.')
  }
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
  const timer = setInterval(() => {
    try { output.update(read(config.state, config.titles, config.foot)) } catch (error) {
      stop()
      process.exitCode = 1
      log(error.code === 'REPORT_CHANGED' ? error.message : 'Watch export failed to read a valid checkpoint or update HTML; stopped. Last successful report is retained when possible. Check state policy, permissions and storage before restarting with a new filename.')
    }
  }, config.watchInterval * 1000)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  log(`Watching saved checkpoints every ${config.watchInterval}s. Refresh the same HTML file in your browser with Ctrl+R; Ctrl+C stops export. No browser is opened and no server is started.`)
  return stop
}

module.exports = { WatchedReport, watchReport }
