#!/usr/bin/env node
'use strict'
const { createHash } = require('node:crypto')
const { openSync, fstatSync, readSync, closeSync, constants } = require('node:fs')
const { isAbsolute } = require('node:path')
const { kiroTitle } = require('./kiro.cjs')
const { sendEvent } = require('./timeline-client.cjs')

function hookStatus(agent, event) {
  const maps = {
    claude: { SessionStart: 'waiting', UserPromptSubmit: 'working', PermissionRequest: 'waiting', PostToolUse: 'working', PostToolUseFailure: 'working', Stop: 'waiting', StopFailure: 'waiting', SessionEnd: 'stopped', Elicitation: 'waiting', ElicitationResult: 'working' },
    'kiro-cli': { agentSpawn: 'waiting', userPromptSubmit: 'working', stop: 'waiting', postToolUse: 'working',
      // CLI V3 PascalCase triggers (agentSpawn is an accepted alias of SessionStart).
      SessionStart: 'waiting', AgentSpawn: 'waiting', UserPromptSubmit: 'working', Stop: 'waiting', PostToolUse: 'working', SessionEnd: 'stopped' },
  }
  if (agent === 'claude' && event.hook_event_name === 'Notification' && ['permission_prompt', 'elicitation_dialog', 'idle_prompt'].includes(event.notification_type)) return 'waiting'
  if (agent === 'claude' && event.hook_event_name === 'PreToolUse') return event.tool_name === 'AskUserQuestion' ? 'waiting' : 'working'
  return maps[agent]?.[event.hook_event_name] || null
}

// Claude records its session name (/rename or --name) and an auto-generated title as
// entries in the session transcript. Only the last such title is extracted, from a
// bounded tail read; nothing else in the transcript is parsed, kept or forwarded.
function sessionTitle(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || !file.endsWith('.jsonl')) return undefined
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd), size = stat.size
    if (!stat.isFile()) return undefined
    const length = Math.min(size, 512 * 1024), buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    let custom, auto
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.includes('-title"')) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (entry?.type === 'custom-title' && typeof entry.customTitle === 'string') custom = entry.customTitle
      else if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string') auto = entry.aiTitle
    }
    const title = (custom || auto || '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, 120)
    return title || undefined
  } catch { return undefined } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}

const titleFor = (agent, payload) => agent === 'claude' ? sessionTitle(payload.transcript_path) : agent === 'kiro-cli' ? kiroTitle(payload.session_id) : undefined

async function run(agent, payload, env = process.env, send = sendEvent) {
  const status = hookStatus(agent, payload)
  if (!status) return
  // Wrapped launch (agent-run.cjs): the launcher owns identity and heartbeats.
  if (env.FOCUS_TRACKER_AGENT === agent && env.FOCUS_TRACKER_SESSION) {
    const wrapped = { type: 'agent', agent, session: env.FOCUS_TRACKER_SESSION, status }
    const title = titleFor(agent, payload)
    if (title) wrapped.title = title
    await send(wrapped)
    return
  }
  // Hooks alone (Claude, Kiro): correlate by the session id the agent puts in its hook
  // payload. Only a one-way hash of it is kept; the id never reaches storage and
  // everything else in the payload is discarded. No heartbeat exists, so the
  // collector applies the longer 'hook' lease to these sessions.
  if (['claude', 'kiro-cli'].includes(agent) && typeof payload.session_id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(payload.session_id)) {
    const session = createHash('sha256').update(payload.session_id).digest('hex').slice(0, 32)
    const event = { type: 'agent', agent, session, status, source: 'hook' }
    const title = titleFor(agent, payload)
    if (title) event.title = title
    await send(event)
    return
  }
  throw new Error('Hook payload has no session id; metadata not recorded. Launch with agent-run.cjs for launcher-based tracking')
}

if (require.main === module) {
  let input = '', tooLarge = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', data => { if (Buffer.byteLength(input) + Buffer.byteLength(data) > 1024 * 1024) { tooLarge = true; input = '' } else if (!tooLarge) input += data })
  process.stdin.on('end', () => {
    Promise.resolve().then(() => {
      if (tooLarge) throw new Error('Hook input exceeds 1 MiB; metadata not recorded')
      let payload
      try { payload = JSON.parse(input) } catch { throw new Error('Invalid hook JSON; metadata not recorded') }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid hook event; metadata not recorded')
      return run(process.argv[2], payload)
    }).catch(error => console.error(`Focus tracker: ${error.message}`))
    // Always exit successfully and emit no stdout: telemetry never blocks a tool,
    // changes a permission decision, or adds text to the agent's prompt context.
  })
}
module.exports = { hookStatus, run, sessionTitle, kiroTitle }
