'use strict'

// Linux-only, opt-in snapshot attribution. Never reads cmdline, environ, cwd,
// terminal contents, or opens a controlling TTY. No subprocesses are spawned.
const fs = require('node:fs')
const { basename } = require('node:path')
const { performance } = require('node:perf_hooks')

const SOURCE = 'proc-pty-foreground-root'
const unknown = (reason) => ({ status: 'unknown', reason })
const executableName = (path) => basename(path.replace(/ \(deleted\)$/, '')).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').slice(0, 80)

function parseStat(text) {
  const close = text.lastIndexOf(')')
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const fields = text.slice(close + 1).trim().split(/\s+/)
  if (close < 0 || !Number.isSafeInteger(pid) || pid <= 0 || fields.length < 20) throw new Error('Invalid process stat')
  const numbers = fields.slice(1, 6).map(Number)
  if (numbers.some((n) => !Number.isSafeInteger(n)) || !/^\d+$/.test(fields[19])) throw new Error('Invalid process stat')
  return { pid, state: fields[0], ppid: numbers[0], pgrp: numbers[1], session: numbers[2], tty: numbers[3], tpgid: numbers[4], start: fields[19] }
}

function read(path) {
  const fd = fs.openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(16385)
    const length = fs.readSync(fd, buffer, 0, buffer.length, null)
    if (length > 16384) throw new Error('Proc response too large')
    return buffer.subarray(0, length).toString('utf8')
  } finally { fs.closeSync(fd) }
}
function list(path, limit) {
  const dir = fs.opendirSync(path)
  const result = []
  try {
    let entry
    while ((entry = dir.readSync())) {
      if (result.length >= limit) { const error = new Error('Scan limit'); error.code = 'SCAN_LIMIT'; throw error }
      result.push(entry.name)
    }
    return result
  } finally { dir.closeSync() }
}

const proc = {
  stat: (pid) => parseStat(read(`/proc/${pid}/stat`)),
  executable: (pid) => fs.readlinkSync(`/proc/${pid}/exe`),
  comm: (pid) => read(`/proc/${pid}/comm`).trim(),
  children: (pid) => read(`/proc/${pid}/task/${pid}/children`).trim().split(/\s+/).filter(Boolean).map(Number),
  fds: (pid) => list(`/proc/${pid}/fdinfo`, 256),
  fdinfo: (pid, fd) => read(`/proc/${pid}/fdinfo/${fd}`),
  pids: () => list('/proc', 8192).filter((name) => /^\d+$/.test(name)).map(Number),
  ttyDevice: (index) => {
    const stat = fs.statSync(`/dev/pts/${index}`, { bigint: true })
    const dev = stat.rdev
    return { character: stat.isCharacterDevice(), major: Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)), minor: Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn)) }
  },
}

// Versioned installs (e.g. .../claude/versions/2.1.319) have a version-number exe
// basename; the kernel's process name is then the meaningful identity.
function executableFor(provider, pid, path) {
  const name = executableName(path)
  if (/^\d+(\.\d+){1,3}$/.test(name) && provider.comm) {
    try { return executableName(provider.comm(pid)) || name } catch { /* keep the basename */ }
  }
  return name
}
function isFoot(window) {
  return Boolean(window?.id && (window.info?.name?.toLowerCase() === 'foot' || window.info?.execName === 'foot'))
}
function sameProcess(a, b) {
  return ['pid', 'start', 'ppid', 'pgrp', 'session', 'tty', 'tpgid'].every((key) => a[key] === b[key])
}

function resolveFoot(window, windows, provider = proc, clock = () => performance.now()) {
  if (!isFoot(window)) return null
  const owner = window.info.processId
  if (!Number.isSafeInteger(owner) || owner <= 0) return unknown('missing-owner-pid')
  if (windows.filter((w) => w.info.processId === owner).length !== 1) return unknown('shared-or-missing-window-owner')
  const started = clock()
  const check = () => { if (clock() - started > 50) { const error = new Error('Scan deadline'); error.code = 'SCAN_TIMEOUT'; throw error } }
  try {
    const ownerStat = provider.stat(owner)
    if (executableName(provider.executable(owner)) !== 'foot') return unknown('unsupported-owner')
    const indexes = new Set()
    for (const fd of provider.fds(owner)) {
      check()
      const match = /^tty-index:\s*(\d+)\s*$/m.exec(provider.fdinfo(owner, fd))
      if (match) {
        const index = Number(match[1])
        if (!Number.isSafeInteger(index) || index < 0) return unknown('invalid-pty')
        indexes.add(index)
      }
    }
    if (indexes.size !== 1) return unknown(indexes.size ? 'multiple-ptys' : 'missing-pty')
    const device = provider.ttyDevice([...indexes][0])
    if (!device.character) return unknown('invalid-pty')
    const matchesTty = (stat) => {
      const tty = stat.tty >>> 0
      return stat.tty !== 0 && ((tty >>> 8) & 0xfff) === device.major && ((tty & 0xff) | ((tty >>> 12) & 0xfff00)) === device.minor
    }
    const children = provider.children(owner)
    if (children.length > 64 || children.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) return unknown('child-scan-limit')
    const anchors = []
    for (const pid of children) {
      check()
      const stat = provider.stat(pid)
      if (stat.ppid === owner && stat.session === pid && matchesTty(stat)) anchors.push(stat)
    }
    if (anchors.length !== 1) return unknown(anchors.length ? 'multiple-tty-anchors' : 'missing-tty-anchor')
    const anchor = anchors[0]
    if (anchor.tpgid <= 0) return unknown('no-foreground-group')
    // Enumerate members of this positively associated group. This is NOT a
    // descendant search for a plausible/deepest process in the terminal tree.
    const pids = provider.pids()
    if (pids.length > 4096) return unknown('process-scan-limit')
    const members = []
    for (const pid of pids) {
      check()
      let stat
      try { stat = provider.stat(pid) } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') continue
        throw error // Incomplete visibility cannot prove that a pipeline is unambiguous.
      }
      if (stat.pgrp === anchor.tpgid && stat.session === anchor.session && matchesTty(stat) && stat.state !== 'Z') members.push(stat)
    }
    const ids = new Set(members.map((m) => m.pid))
    const roots = members.filter((m) => !ids.has(m.ppid))
    if (roots.length !== 1) return unknown(roots.length ? 'multiple-foreground-roots' : 'foreground-group-unavailable')
    const root = roots[0]
    if (root.pid !== anchor.tpgid) return unknown('foreground-leader-unavailable')
    if (root.pid !== anchor.pid && root.ppid !== anchor.pid) return unknown('detached-foreground-root')
    if (['T', 't', 'X'].includes(root.state)) return unknown('foreground-not-running')
    const path = provider.executable(root.pid)
    const executable = executableFor(provider, root.pid, path)
    if (!executable) return unknown('missing-executable')
    check()
    // Revalidate owner, controlling-TTY anchor, leader, and executable. Start
    // times prevent accepting PID reuse during a snapshot; nothing is PID-cached.
    if (!sameProcess(ownerStat, provider.stat(owner)) || !sameProcess(anchor, provider.stat(anchor.pid)) ||
        !sameProcess(root, provider.stat(root.pid)) || provider.executable(root.pid) !== path) return unknown('process-race')
    const finalIndexes = new Set()
    for (const fd of provider.fds(owner)) {
      check()
      const match = /^tty-index:\s*(\d+)\s*$/m.exec(provider.fdinfo(owner, fd))
      if (match) finalIndexes.add(Number(match[1]))
    }
    if (finalIndexes.size !== 1 || !finalIndexes.has([...indexes][0])) return unknown('pty-race')
    check()
    return { status: 'resolved', executable, foregroundPid: root.pid, source: SOURCE }
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) return unknown('permission-denied')
    if (['ENOENT', 'ESRCH'].includes(error.code)) return unknown('process-exited')
    if (error.code === 'SCAN_LIMIT') return unknown('scan-limit')
    if (error.code === 'SCAN_TIMEOUT') return unknown('scan-timeout')
    return unknown('unavailable-proc-metadata')
  }
}

module.exports = { isFoot, resolveFoot, parseStat, SOURCE, proc, executableName, executableFor }
