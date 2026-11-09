'use strict'
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { defaultSocket } = require('./timeline-store.cjs')

function sendEvent(event, socketPath = defaultSocket()) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let reply = ''
    const done = (error) => { socket.destroy(); error ? reject(error) : resolve() }
    socket.setTimeout(1500, () => done(new Error('Timeline collector timeout')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(event) + '\n'))
    socket.on('data', data => {
      reply += data
      if (reply.length > 4096) return done(new Error('Invalid collector response'))
      if (reply.includes('\n')) {
        try { const result = JSON.parse(reply); done(result.ok ? null : new Error(result.error || 'Timeline event rejected')) }
        catch { done(new Error('Invalid collector response')) }
      }
    })
    socket.on('end', () => { if (!reply.includes('\n')) done(new Error('Collector closed without acknowledgement')) })
  })
}

// Coalesce native polls into intervals; duration uses the accounting monotonic clock.
class HumanTimeline {
  constructor({ socket, now, wall = Date.now(), send = sendEvent, onError = console.error }) {
    this.socket = socket
    this.origin = wall - now
    this.session = randomUUID()
    this.pending = null
    this.queue = Promise.resolve()
    this.send = send
    this.onError = onError
    this.queued = 0
  }
  record(state, start, end, title, executable = null) {
    if (end <= start) return
    if (end - start > 60000) {
      this.flush()
      this.onError('Timeline sampling gap exceeds 60s; interval omitted rather than inventing a wall-clock span.')
      return
    }
    const item = { type: 'human', session: this.session, status: state.kind }
    if (state.kind === 'tracking') { item.app = state.app; if (title !== null) item.title = title; if (executable) item.executable = executable }
    const a = Math.round(this.origin + start), b = Math.round(this.origin + end)
    if (b <= a) return
    const key = JSON.stringify(item)
    if (this.pending && (this.pending.key !== key || b - this.pending.event.start > 5000 || a !== this.pending.event.end)) this.flush()
    if (!this.pending) this.pending = { key, event: { ...item, start: a, end: b } }
    else this.pending.event.end = b
    if (b - this.pending.event.start >= 5000) this.flush()
  }
  flush() {
    if (!this.pending) return this.queue
    const { event } = this.pending
    this.pending = null
    if (this.queued >= 100) { this.onError('Timeline queue full; interval dropped'); return this.queue }
    this.queued++
    this.queue = this.queue.then(() => this.send(event, this.socket)).catch(() => {
      this.onError('Timeline collector unavailable; interval was not saved (foreground checkpoints continue).')
    }).finally(() => { this.queued-- })
    return this.queue
  }
}
module.exports = { sendEvent, HumanTimeline }
