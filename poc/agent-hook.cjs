#!/usr/bin/env node
'use strict'
const { sendEvent } = require('./timeline-client.cjs')

function hookStatus(agent, event) {
  const maps = {
    claude: { SessionStart: 'waiting', UserPromptSubmit: 'working', PermissionRequest: 'waiting', PostToolUse: 'working', PostToolUseFailure: 'working', Stop: 'waiting', StopFailure: 'waiting', SessionEnd: 'stopped', Elicitation: 'waiting', ElicitationResult: 'working' },
    'kiro-cli': { agentSpawn: 'waiting', userPromptSubmit: 'working', stop: 'waiting', postToolUse: 'working' },
  }
  if (agent === 'claude' && event.hook_event_name === 'Notification' && ['permission_prompt', 'elicitation_dialog', 'idle_prompt'].includes(event.notification_type)) return 'waiting'
  if (agent === 'claude' && event.hook_event_name === 'PreToolUse') return event.tool_name === 'AskUserQuestion' ? 'waiting' : 'working'
  return maps[agent]?.[event.hook_event_name] || null
}

async function run(agent, payload, env = process.env, send = sendEvent) {
  const status = hookStatus(agent, payload)
  if (!status) return
  if (env.FOCUS_TRACKER_AGENT !== agent || !env.FOCUS_TRACKER_SESSION) throw new Error('Launch this agent with agent-run.cjs to enable session tracking')
  // Deliberately discard all input except the event discriminator.
  await send({ type: 'agent', agent, session: env.FOCUS_TRACKER_SESSION, status })
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
module.exports = { hookStatus, run }
