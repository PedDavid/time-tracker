'use strict'

// Only read-only Hyprland commands; never invoke hyprctl, jq or a shell.
const net = require('node:net')
const { join } = require('node:path')
const REASONS = new Set(['UNKNOWN', 'NOTIFICATION', 'LOCK', 'WORKSPACE', 'WINDOWED', 'DND', 'SPECIAL', 'ALPHA', 'OFFSET', 'CANDIDATE', 'OPAQUE', 'TRANSFORM', 'OVERLAYS', 'FLOAT', 'WORKSPACES', 'SURFACES', 'CONFIGERROR', 'FADEOUT'])

function socketPath(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR
  const signature = env.HYPRLAND_INSTANCE_SIGNATURE
  if (!runtime || !runtime.startsWith('/') || !signature || ['.', '..'].includes(signature) || !/^[a-zA-Z0-9_.-]{1,200}$/.test(signature)) throw new Error('Hyprland connection unavailable')
  const path = join(runtime, 'hypr', signature, '.socket.sock')
  if (Buffer.byteLength(path) > 107) throw new Error('Hyprland socket path too long')
  return path
}

function request(path, command, { signal, timeout = 750, maxBytes = 256 * 1024 } = {}) {
  if (!['j/version', 'j/monitors'].includes(command)) return Promise.reject(new Error('Not a read-only activity command'))
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Cancelled')); return }
    const socket = net.createConnection(path)
    let chunks = [], size = 0, finished = false
    const timer = setTimeout(() => finish(new Error('Hyprland timeout')), timeout)
    const abort = () => finish(new Error('Cancelled'))
    const finish = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    signal?.addEventListener('abort', abort, { once: true })
    socket.on('connect', () => socket.write(command))
    socket.on('error', () => finish(new Error('Hyprland disconnected')))
    socket.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) { finish(new Error('Hyprland response too large')); return }
      chunks.push(chunk)
    })
    socket.on('end', () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { finish(new Error('Invalid Hyprland JSON')) }
    })
    socket.on('close', () => { if (!finished) finish(new Error('Hyprland incomplete response')) })
  })
}

function validateVersion(value) {
  // This is an internal diagnostic field, not a stable lock protocol. New
  // versions require source review before extending this allowlist.
  if (!value || value.tag !== 'v0.56.2' || value.commit !== 'efb50993780079460b0cbed1363e2166a2de1d9f' || value.dirty !== false) throw new Error('Unreviewed Hyprland lock capability')
  return true
}

function lockState(monitors) {
  if (!Array.isArray(monitors) || monitors.length === 0 || monitors.length > 64) throw new Error('No readable monitors')
  let readable = false, locked = false
  for (const monitor of monitors) {
    if (!monitor || !Object.hasOwn(monitor, 'solitaryBlockedBy')) throw new Error('Missing lock capability')
    const reasons = monitor.solitaryBlockedBy
    // null is the documented serialization of zero blockers, NOT a missing field.
    if (reasons !== null && (!Array.isArray(reasons) || reasons.length > REASONS.size || reasons.some((r) => !REASONS.has(r)) || new Set(reasons).size !== reasons.length)) throw new Error('Unknown lock schema')
    if (reasons?.includes('LOCK')) locked = true
    if (!reasons?.includes('WORKSPACE')) readable = true
  }
  if (locked) return 'locked'
  if (readable) return 'unlocked'
  throw new Error('Lock determination unavailable')
}

module.exports = { socketPath, request, validateVersion, lockState }
