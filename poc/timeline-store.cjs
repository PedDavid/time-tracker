'use strict'

const fs = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')

const LEASE_MS = 45000
// Hook-only sessions have no heartbeat: a working turn may go quiet while the model
// generates, and a waiting session is idle until the next prompt.
const HOOK_WORKING_LEASE_MS = 10 * 60000
const HOOK_WAITING_LEASE_MS = 30 * 60000
const leaseFor = (source, status) => source === 'hook' ? (status === 'waiting' ? HOOK_WAITING_LEASE_MS : HOOK_WORKING_LEASE_MS) : LEASE_MS
const MAX_BYTES = 64 * 1024 * 1024
const AGENTS = ['claude', 'pi', 'kiro-cli']
const HUMAN_STATES = ['tracking', 'waiting', 'paused', 'no focus', 'IPC unavailable', 'idle', 'locked', 'activity-unavailable']
const defaultDirectory = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'focus-tracker', 'timeline')
const defaultSocket = () => process.env.FOCUS_TRACKER_SOCKET || join(defaultDirectory(), 'collector.sock')
const text = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(s)
const timestamp = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000

// Whitelist fields at the boundary. Never store raw hook payloads, paths or prompts.
function validateEvent(input, now) {
  if (!input || typeof input !== 'object') throw new Error('Invalid event')
  if (input.type === 'agent') {
    if (!AGENTS.includes(input.agent) || typeof input.session !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.session) ||
        !['working', 'waiting', 'stopped', 'heartbeat'].includes(input.status)) throw new Error('Invalid agent event')
    if (input.source !== undefined && input.source !== 'hook') throw new Error('Invalid agent event')
    if (input.title !== undefined && !text(input.title, 120)) throw new Error('Invalid agent event')
    const event = { type: 'agent', agent: input.agent, session: input.session, status: input.status }
    if (input.source) event.source = input.source
    if (input.title !== undefined) event.title = input.title
    return event
  }
  if (input.type === 'human') {
    if (typeof input.session !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.session) || !HUMAN_STATES.includes(input.status) ||
        !timestamp(input.start) || !timestamp(input.end) || input.end <= input.start || input.end - input.start > 60000 ||
        input.end > now + 5000 || input.start < now - 300000 ||
        (input.status === 'tracking' && !text(input.app, 80)) ||
        (input.title !== undefined && !text(input.title, 240)) ||
        (input.executable !== undefined && !text(input.executable, 80))) throw new Error('Invalid human interval')
    const event = { type: 'human', session: input.session, status: input.status, start: input.start, end: input.end }
    if (input.status === 'tracking') event.app = input.app
    if (input.title !== undefined && input.status === 'tracking') event.title = input.title
    if (input.executable !== undefined && input.status === 'tracking') event.executable = input.executable
    return event
  }
  throw new Error('Unknown event type')
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Timeline directory must be a private directory owned by this user (mode 0700)')
  }
}

class TimelineStore {
  constructor(directory, clock = Date.now) {
    privateDirectory(directory)
    this.clock = clock
    this.events = []
    this.fd = null
    this.lock = null
    try {
      this.lock = fs.openSync(join(directory, 'collector.lock'), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
      this.checkFile(this.lock)
      const lock = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', this.lock], timeout: 3000 })
      if (lock.status !== 0) throw new Error('Timeline collector already running, or flock unavailable')
      this.fd = fs.openSync(join(directory, 'events.jsonl'), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600)
      const stat = this.checkFile(this.fd)
      if (stat.size > MAX_BYTES) throw new Error('Timeline journal exceeds 64 MiB; archive it while collector is stopped')
      const content = fs.readFileSync(this.fd, 'utf8')
      const end = content.lastIndexOf('\n') + 1
      for (const line of content.slice(0, end).split('\n').filter(Boolean)) {
        let e
        try { e = JSON.parse(line) } catch { throw new Error('Malformed timeline journal; preserved without overwriting') }
        if (e.version !== 1 || !timestamp(e.at) || typeof e.id !== 'string') throw new Error('Invalid timeline journal')
        if (e.type !== 'reset') validateEvent(e, e.at)
        this.events.push(e)
      }
      // A crash can leave only the final unacknowledged frame incomplete.
      if (end !== content.length) fs.ftruncateSync(this.fd, Buffer.byteLength(content.slice(0, end)))
      this.append({ type: 'reset' })
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
    } catch (error) { this.close(); throw error }
  }

  checkFile(fd) {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('Timeline files must be private regular files owned by this user')
    return stat
  }

  append(event) {
    if (this.failed) throw new Error('Timeline journal write failed; restart the collector after fixing storage')
    const at = Math.max(this.clock(), this.events.at(-1)?.at || 0)
    const record = { ...event, version: 1, at, id: randomUUID() }
    const content = Buffer.from(JSON.stringify(record) + '\n')
    if (fs.fstatSync(this.fd).size + content.length > MAX_BYTES) throw new Error('Timeline journal full; archive it with the collector stopped')
    // The collector serializes all writers; acknowledge only after fsync.
    try {
      let offset = 0
      while (offset < content.length) offset += fs.writeSync(this.fd, content, offset)
      fs.fsyncSync(this.fd)
    } catch (error) {
      // Never append another frame after a partial write: startup can repair
      // only an incomplete tail, not a fragment embedded in the journal.
      this.failed = true
      throw error
    }
    this.events.push(record)
    return record
  }

  accept(input) { return this.append(validateEvent(input, this.clock())) }
  close() {
    if (this.fd !== null) fs.closeSync(this.fd)
    if (this.lock !== null) fs.closeSync(this.lock)
    this.fd = this.lock = null
  }
}

function project(events, now = Date.now(), { from = now - 86400000, to = now, agent = '', status = '', includeAgents = '' } = {}) {
  const spans = []
  const sessions = new Map()
  const humans = new Map()
  const titles = new Map()
  function add(s, end, interrupted = false) {
    if (end > s.start) spans.push({ ...s, end, interrupted })
  }
  function finish(s, at, reset = false) {
    const stale = reset || at - s.seen > s.lease
    const end = stale ? s.seen : at
    add(s.span, end, stale)
    if (stale && at > end) add({ ...s.span, id: `${s.span.id}-gap`, start: end, status: 'unknown' }, at, true)
  }
  for (const e of events) {
    if (e.type === 'human') {
      const previous = humans.get(e.session)
      if (previous && previous.end === e.start && previous.status === e.status && previous.app === e.app && previous.title === e.title && previous.executable === e.executable) previous.end = e.end
      else {
        const span = { id: e.id, actor: `human:${e.session}`, agent: 'human', session: e.session, status: e.status, app: e.app, title: e.title, executable: e.executable, start: e.start, end: e.end }
        spans.push(span)
        humans.set(e.session, span)
      }
    } else if (e.type === 'reset') {
      for (const s of sessions.values()) finish(s, s.seen, true)
      sessions.clear()
    } else {
      const actor = `${e.agent}:${e.session}`
      if (e.title) titles.set(actor, e.title)
      const previous = sessions.get(actor)
      if (e.status === 'heartbeat') {
        if (previous && e.at - previous.seen <= previous.lease) previous.seen = e.at
        // A heartbeat alone cannot prove task state after a disconnect/restart.
        continue
      }
      if (previous) {
        if (previous.span.status === e.status && e.at - previous.seen <= previous.lease) { previous.seen = e.at; continue }
        finish(previous, e.at)
        sessions.delete(actor)
      }
      if (e.status !== 'stopped') sessions.set(actor, { seen: e.at, lease: leaseFor(e.source, e.status), span: { id: e.id, actor, agent: e.agent, session: e.session, status: e.status, start: e.at } })
    }
  }
  for (const s of sessions.values()) finish(s, now)
  // The latest known title names the whole session lane, including earlier spans.
  for (const span of spans) if (titles.has(span.actor)) span.title = titles.get(span.actor)
  const visible = spans.filter(s => s.end > from && s.start < to && (includeAgents
    ? (s.agent === 'human' ? (!status || s.status === status) : (includeAgents === 'agents' || s.agent === includeAgents))
    : ((!agent || (agent === 'agents' ? s.agent !== 'human' : s.agent === agent)) && (!status || s.status === status))))
    .map(s => ({ ...s, start: Math.max(from, s.start), end: Math.min(to, s.end) }))
    .sort((a, b) => a.start - b.start || a.actor.localeCompare(b.actor))
  const totals = { humanMs: 0, agentMs: 0, waitingMs: 0 }
  let humanEnd = -1
  for (const s of visible) {
    const ms = s.end - s.start
    if (s.agent === 'human' && s.status === 'tracking') {
      totals.humanMs += Math.max(0, s.end - Math.max(humanEnd, s.start))
      humanEnd = Math.max(humanEnd, s.end)
    }
    if (s.agent !== 'human' && s.status === 'working') totals.agentMs += ms
    if (s.agent !== 'human' && s.status === 'waiting') totals.waitingMs += ms
  }
  return { from, to, now, totals, truncated: visible.length > 10000, spans: visible.slice(-10000) }
}

module.exports = { TimelineStore, project, validateEvent, privateDirectory, defaultDirectory, defaultSocket, LEASE_MS, MAX_BYTES }
