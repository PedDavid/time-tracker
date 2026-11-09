// Load explicitly: pi -e /absolute/path/to/pi-timeline.mjs
// Uses only lifecycle event names. Never reads prompts, messages, tools or history.
import { randomUUID } from 'node:crypto'
import client from '../timeline-client.cjs'

export default function timeline(pi) {
  let session, timer, busy = false, waiting = false
  let queue = Promise.resolve()
  const emit = status => {
    const id = session
    if (!id) return queue
    queue = queue.then(() => client.sendEvent({ type: 'agent', agent: 'pi', session: id, status }))
      .catch(() => { console.error('Focus tracker: Pi timeline event not saved; check the collector') })
    return queue
  }
  pi.on('session_start', async () => {
    session = randomUUID()
    busy = waiting = false
    await emit('waiting')
    clearInterval(timer)
    timer = setInterval(() => { void emit('heartbeat') }, 10000)
    timer.unref()
  })
  pi.on('agent_start', async () => { busy = true; await emit(waiting ? 'waiting' : 'working') })
  // agent_settled includes automatic retries and queued continuations. agent_end
  // is not a final idle boundary in current Pi and must not close the task.
  pi.on('agent_settled', async () => { busy = false; await emit('waiting') })
  pi.on('ui_prompt_start', async () => { waiting = true; await emit('waiting') })
  pi.on('ui_prompt_end', async () => { waiting = false; await emit(busy ? 'working' : 'waiting') })
  pi.on('session_shutdown', async () => { clearInterval(timer); await emit('stopped'); session = undefined })
}
