'use strict'

// Opt-in kitty attribution. kitty hosts every window in one process, so the
// foot PTY proof cannot apply. Instead this asks kitty's own remote-control
// socket which window is on screen and which process group is in its foreground,
// then resolves the group's root through /proc exactly like foot. Titles, cwd,
// cmdlines and env in kitty's reply are never read: only ids, focus flags and
// foreground pids are used, and only an executable basename is returned.
const { execFileSync } = require('node:child_process')
const { proc, executableFor, parseStat } = require('./foot.cjs')

const SOURCE = 'kitty-remote-control-foreground-root'
const unknown = (reason) => ({ status: 'unknown', reason })
const isKitty = (window) => Boolean(window?.id && (/^kitty(-\d+)?$/i.test(window.info?.name || '') || window.info?.execName === 'kitty'))

function kittyLs(address) {
  const output = execFileSync('kitten', ['@', '--to', address, 'ls'], { timeout: 750, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(output.toString('utf8'))
}

function resolveKitty(window, { address = process.env.KITTY_LISTEN_ON, ls = kittyLs, provider = proc } = {}) {
  if (!isKitty(window)) return null
  if (!address || !/^unix:@?[\w./-]{1,200}$/.test(address)) return unknown('kitty-remote-control-unavailable')
  try {
    const tree = ls(address)
    if (!Array.isArray(tree)) return unknown('kitty-invalid-response')
    const name = window.info.name
    let osWindows = tree.filter((o) => o.wm_class === name)
    if (osWindows.length > 1) osWindows = osWindows.filter((o) => o.is_focused === true)
    if (osWindows.length !== 1) return unknown(osWindows.length ? 'kitty-ambiguous-window' : 'kitty-window-not-found')
    const tabs = (osWindows[0].tabs || []).filter((t) => t.is_active === true)
    if (tabs.length !== 1) return unknown('kitty-active-tab-unavailable')
    const windows = (tabs[0].windows || []).filter((w) => w.is_active === true)
    if (windows.length !== 1) return unknown('kitty-active-window-unavailable')
    const pids = (windows[0].foreground_processes || []).map((p) => p?.pid)
    if (!pids.length || pids.length > 64 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) return unknown('no-foreground-group')
    const stats = pids.map((pid) => provider.stat(pid))
    const ids = new Set(pids)
    const roots = stats.filter((s) => !ids.has(s.ppid))
    if (roots.length !== 1) return unknown(roots.length ? 'multiple-foreground-roots' : 'foreground-group-unavailable')
    const root = roots[0]
    if (['T', 't', 'X', 'Z'].includes(root.state)) return unknown('foreground-not-running')
    const path = provider.executable(root.pid)
    const executable = executableFor(provider, root.pid, path)
    if (!executable) return unknown('missing-executable')
    // Revalidate against PID reuse: same start time and executable.
    const again = provider.stat(root.pid)
    if (again.start !== root.start || provider.executable(root.pid) !== path) return unknown('process-race')
    return { status: 'resolved', executable, foregroundPid: root.pid, source: SOURCE }
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) return unknown('permission-denied')
    if (['ENOENT', 'ESRCH'].includes(error.code)) return unknown('process-exited')
    return unknown('kitty-remote-control-unavailable')
  }
}

module.exports = { isKitty, resolveKitty, SOURCE, parseStat }
