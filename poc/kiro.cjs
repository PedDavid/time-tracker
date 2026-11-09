'use strict'
const { openSync, fstatSync, readSync, closeSync, readdirSync, constants } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

// Kiro keeps each session's title in two places: the CLI writes
// <home>/sessions/cli/<uuid>.json (also named by `--resume-id <uuid>`), the IDE-style
// store writes <home>/sessions/<workspace>/sess_<uuid>/session.json. Only the sanitized
// `title` string is used; ids must match Kiro's own formats and files are bounded.
const UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/
const MAX_BYTES = 16 * 1024 * 1024

function readTitle(file) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined
    const buffer = Buffer.alloc(stat.size)
    readSync(fd, buffer, 0, stat.size, 0)
    const title = String(JSON.parse(buffer.toString('utf8')).title || '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, 120)
    return title || undefined
  } catch { return undefined } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}

function kiroTitle(id, home = join(homedir(), '.kiro')) {
  if (typeof id !== 'string') return undefined
  const root = join(home, 'sessions')
  if (UUID.test(id)) return readTitle(join(root, 'cli', `${id}.json`))
  if (!/^sess_[0-9a-fA-F-]{36}$/.test(id)) return undefined
  let workspaces
  try { workspaces = readdirSync(root) } catch { return undefined }
  for (const workspace of workspaces) {
    const title = readTitle(join(root, workspace, id, 'session.json'))
    if (title) return title
  }
  return undefined
}

// Terminal title of a resumed Kiro CLI session: "kiro-cli ... --resume-id <uuid>".
// Returns "kiro-cli: <session name>" when the name is known, else the original title.
const cache = new Map()
function kiroWindowTitle(title, now = Date.now(), home) {
  const match = typeof title === 'string' && /^kiro-cli\b.*--resume-id[ =]([0-9a-fA-F-]{36})\b/.exec(title)
  if (!match) return title
  const hit = cache.get(match[1])
  let name
  if (hit && now - hit.at < 30000) name = hit.name
  else {
    name = kiroTitle(match[1], home)
    if (cache.size > 200) cache.clear()
    cache.set(match[1], { at: now, name })
  }
  return name ? `kiro-cli: ${name}`.slice(0, 240) : title
}

module.exports = { kiroTitle, kiroWindowTitle }
