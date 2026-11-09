#!/usr/bin/env node
'use strict'
const { join } = require('node:path')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
function configuration(agent) {
  const command = `${quote(process.execPath)} ${quote(join(__dirname, 'agent-hook.cjs'))} ${quote(agent)}`
  if (agent === 'claude') {
    const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'Elicitation', 'ElicitationResult']
    return { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 3 }] }]])) }
  }
  if (agent === 'kiro-cli') return { name: 'focus-tracker', description: 'Agent with local focus timeline hooks', hooks: Object.fromEntries(['agentSpawn', 'userPromptSubmit', 'postToolUse', 'stop'].map(event => [event, [{ command, timeout_ms: 3000, cache_ttl_seconds: 0 }]])) }
  throw new Error('Usage: node poc/agent-config.cjs claude|kiro-cli')
}
if (require.main === module) {
  try { console.log(JSON.stringify(configuration(process.argv[2]), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { configuration }
