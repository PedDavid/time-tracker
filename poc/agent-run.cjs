#!/usr/bin/env node
'use strict'
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { sendEvent } = require('./timeline-client.cjs')

async function run(args) {
  const split = args.indexOf('--')
  if (split !== 2 || !['claude', 'pi', 'kiro-cli'].includes(args[1]) || args[0] !== '--agent' || !args[3]) {
    throw new Error('Usage: node poc/agent-run.cjs --agent claude|pi|kiro-cli -- COMMAND [ARGS...]')
  }
  const agent = args[1], session = randomUUID()
  const event = status => sendEvent({ type: 'agent', agent, session, status })
  // Fail before launching if no collector: never imply that an untracked run is tracked.
  await event('waiting')
  const child = spawn(args[3], args.slice(4), { stdio: 'inherit', env: { ...process.env, FOCUS_TRACKER_AGENT: agent, FOCUS_TRACKER_SESSION: session } })
  const heartbeat = setInterval(() => { event('heartbeat').catch(() => console.error('Focus tracker: collector unavailable; session state may be unknown')) }, 10000)
  const forward = signal => { if (!child.killed) child.kill(signal) }
  // Terminal-generated SIGINT reaches both processes; forwarding SIGTERM/SIGHUP
  // also supports launchers without an interactive terminal.
  const term = () => forward('SIGTERM'), hup = () => forward('SIGHUP')
  process.on('SIGTERM', term); process.on('SIGHUP', hup)
  process.on('SIGINT', interrupt)
  function interrupt() { if (!process.stdin.isTTY) forward('SIGINT') }
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    await event('stopped').catch(() => console.error('Focus tracker: final event not saved; session will expire'))
    return result.code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[result.signal] || 1)
  } catch (error) {
    await event('stopped').catch(() => {})
    throw error
  } finally {
    clearInterval(heartbeat)
    process.removeListener('SIGTERM', term); process.removeListener('SIGHUP', hup); process.removeListener('SIGINT', interrupt)
  }
}
if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { run }
