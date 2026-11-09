'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const { TimelineStore, project, validateEvent, LEASE_MS } = require('./timeline-store.cjs')
const { HumanTimeline, sendEvent } = require('./timeline-client.cjs')
const { startServer } = require('./timeline-server.cjs')
const { Accounting } = require('./accounting.cjs')
const { hookStatus, run: hook } = require('./agent-hook.cjs')
const { configuration } = require('./agent-config.cjs')
const temporary = () => fs.mkdtempSync(join(tmpdir(), 'focus-timeline-'))
const event = (at, agent, session, status) => ({ type: 'agent', at, agent, session, status, id: `${session}-${at}` })

test('parallel agents have independent execution, waiting and human totals; range clips spans', () => {
  const events = [event(100, 'claude', 'a', 'working'), event(200, 'pi', 'b', 'working'), event(300, 'claude', 'a', 'waiting'), event(400, 'pi', 'b', 'stopped'), event(500, 'claude', 'a', 'stopped'), { type: 'human', id: 'human', session: 'h', start: 100, end: 500, status: 'tracking', app: 'Editor' }]
  const view = project(events, 600, { from: 150, to: 450 })
  assert.deepEqual(view.totals, { humanMs: 300, agentMs: 350, waitingMs: 150 })
  assert.equal(new Set(view.spans.map(s => s.actor)).size, 3)
  assert.ok(view.spans.every(s => s.start >= 150 && s.end <= 450))
  assert.equal(project(events, 600, { from: 0, to: 600, agent: 'pi', status: 'working' }).totals.agentMs, 200)
  const agents = project(events, 600, { from: 0, to: 600, agent: 'agents' })
  assert.ok(agents.spans.every(span => span.agent !== 'human'))
  assert.deepEqual(agents.totals, { humanMs: 0, agentMs: 400, waitingMs: 200 })
})

test('heartbeats coalesce intervals, expire conservatively and cannot restart a stopped or lost task', () => {
  const events = [event(0, 'claude', 'a', 'working'), event(10000, 'claude', 'a', 'heartbeat'), event(20000, 'claude', 'a', 'working')]
  assert.equal(project(events, 30000, { from: 0, to: 30000 }).totals.agentMs, 30000)
  const expired = project(events, 100000, { from: 0, to: 100000 })
  assert.equal(expired.totals.agentMs, 20000)
  assert.deepEqual(expired.spans.map(s => s.status), ['working', 'unknown'])
  events.push(event(100000, 'claude', 'a', 'heartbeat'), event(110000, 'claude', 'a', 'waiting'), event(120000, 'claude', 'a', 'stopped'), event(130000, 'claude', 'a', 'heartbeat'))
  const view = project(events, 140000, { from: 0, to: 140000 })
  assert.equal(view.totals.agentMs, 20000)
  assert.equal(view.totals.waitingMs, 10000)
  assert.equal(view.spans.at(-1).end, 120000)
})

test('collector restarts cut open tasks at last evidence and never bill downtime', () => {
  const events = [event(0, 'pi', 'a', 'working'), event(10000, 'pi', 'a', 'heartbeat'), { type: 'reset', at: 100000 }, event(110000, 'pi', 'a', 'heartbeat')]
  assert.equal(project(events, 120000, { from: 0, to: 120000 }).totals.agentMs, 10000)
})

test('human chunks merge only when adjacent and human focused totals do not double-count overlapping trackers', () => {
  const interval = (session, start, end, app = 'Editor') => ({ type: 'human', id: `${session}-${start}`, session, start, end, app, status: 'tracking' })
  const view = project([interval('a', 100, 200), interval('b', 150, 250), interval('a', 200, 300), interval('a', 300, 400, 'Browser')], 500, { from: 0, to: 500 })
  assert.equal(view.spans.length, 3)
  assert.equal(view.spans[0].end, 300)
  assert.equal(view.totals.humanMs, 300)
})

test('a partial storage write poisons the writer until restart and repairs only the tail', () => {
  const directory = temporary()
  let store
  const original = fs.writeSync
  try {
    store = new TimelineStore(directory, () => 1000)
    const fd = store.fd
    fs.writeSync = (...args) => {
      if (args[0] !== fd) return original(...args)
      original(fd, args[1], 0, 8)
      throw new Error('Synthetic full disk')
    }
    assert.throws(() => store.accept({ type: 'agent', agent: 'pi', session: 'a', status: 'working' }), /full disk/)
    fs.writeSync = original
    const bytes = fs.statSync(join(directory, 'events.jsonl')).size
    assert.throws(() => store.accept({ type: 'agent', agent: 'pi', session: 'a', status: 'stopped' }), /restart/)
    assert.equal(fs.statSync(join(directory, 'events.jsonl')).size, bytes)
    store.close(); store = new TimelineStore(directory, () => 2000)
    assert.deepEqual(store.events.map(e => e.type), ['reset', 'reset'])
  } finally { fs.writeSync = original; store?.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('journal enforces one writer, private files, restart recovery and torn-tail repair', () => {
  const directory = temporary()
  let store
  try {
    let now = 1000
    store = new TimelineStore(directory, () => now)
    store.accept({ type: 'agent', agent: 'pi', session: 'a', status: 'working', prompt: 'NEVER_STORE' })
    now = 2000
    store.accept({ type: 'agent', agent: 'pi', session: 'a', status: 'heartbeat' })
    assert.throws(() => new TimelineStore(directory), /already running/)
    const file = join(directory, 'events.jsonl')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.ok(!fs.readFileSync(file, 'utf8').includes('NEVER_STORE'))
    store.close(); store = null
    fs.appendFileSync(file, '{"incomplete":')
    now = 100000
    store = new TimelineStore(directory, () => now)
    assert.equal(project(store.events, now, { from: 0, to: now }).totals.agentMs, 1000)
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'))
    assert.equal(store.events.at(-1).type, 'reset')
  } finally { store?.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('journal refuses corrupt complete frames, symlinks and non-private storage', () => {
  for (const kind of ['corrupt', 'symlink', 'public']) {
    const directory = temporary()
    try {
      const file = join(directory, 'events.jsonl')
      if (kind === 'corrupt') fs.writeFileSync(file, '{"invalid":true}\n', { mode: 0o600 })
      if (kind === 'symlink') fs.symlinkSync(join(directory, 'target'), file)
      if (kind === 'public') fs.chmodSync(directory, 0o755)
      assert.throws(() => new TimelineStore(directory))
      if (kind === 'corrupt') assert.equal(fs.readFileSync(file, 'utf8'), '{"invalid":true}\n')
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  }
})

test('collector validates events and whitelists fields without retaining sensitive hook input', () => {
  assert.throws(() => validateEvent({ type: 'agent', agent: 'other', session: 'a', status: 'working' }, 100))
  assert.throws(() => validateEvent({ type: 'agent', agent: 'pi', session: '../path', status: 'working' }, 100))
  const input = { type: 'human', session: 'h', status: 'tracking', app: 'Editor', start: 10, end: 100, prompt: 'private' }
  assert.equal(validateEvent(input, 100).prompt, undefined)
  for (const fields of [{ end: 9 }, { start: -1 }, { end: 100000 }, { status: 'invented' }, { app: '\n' }, { title: '\x00' }]) assert.throws(() => validateEvent({ ...input, ...fields }, 100))
})

test('human intervals share exact accounting boundaries and title privacy, coalescing native polls', async () => {
  const saved = []
  const recorder = new HumanTimeline({ now: 0, wall: 1000, send: async e => saved.push(e) })
  const ledger = new Accounting(0, null, (...args) => recorder.record(...args))
  ledger.observe('Editor', 10)
  ledger.snapshot(20); ledger.snapshot(30)
  ledger.togglePause(40)
  ledger.snapshot(60)
  await recorder.flush()
  assert.deepEqual(saved.map(e => [e.status, e.start, e.end]), [['waiting', 1000, 1010], ['tracking', 1010, 1040], ['paused', 1040, 1060]])
  assert.ok(saved.every(e => !('title' in e)))
  assert.equal(saved.reduce((sum, e) => sum + e.end - e.start, 0), 60)
})

test('timeline transport failures leave accounting working and emit a diagnostic', async () => {
  const warnings = []
  const recorder = new HumanTimeline({ now: 0, wall: 1000, send: async () => { throw new Error('offline') }, onError: e => warnings.push(e) })
  const ledger = new Accounting(0, null, (...args) => recorder.record(...args))
  ledger.observe('Editor', 0); ledger.snapshot(100)
  await recorder.flush()
  assert.equal(ledger.snapshot(100).trackedMs, 100)
  assert.match(warnings[0], /unavailable/)
  recorder.record({ kind: 'tracking', app: 'Editor' }, 100, 100000, null)
  assert.match(warnings.at(-1), /sampling gap/)
})

test('Claude/Kiro hooks distinguish lifecycle states and do not forward payloads', async () => {
  const sent = []
  const env = { FOCUS_TRACKER_AGENT: 'claude', FOCUS_TRACKER_SESSION: 'synthetic-session' }
  await hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE', cwd: '/PRIVATE', session_id: 'PRIVATE' }, env, async e => sent.push(e))
  assert.deepEqual(sent, [{ type: 'agent', agent: 'claude', session: 'synthetic-session', status: 'working' }])
  for (const name of ['PermissionRequest', 'Stop', 'StopFailure', 'Elicitation']) assert.equal(hookStatus('claude', { hook_event_name: name }), 'waiting')
  assert.equal(hookStatus('claude', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), 'waiting')
  assert.equal(hookStatus('claude', { hook_event_name: 'PostToolUse' }), 'working')
  assert.equal(hookStatus('claude', { hook_event_name: 'SessionEnd' }), 'stopped')
  assert.equal(hookStatus('kiro-cli', { hook_event_name: 'userPromptSubmit' }), 'working')
  assert.equal(hookStatus('kiro-cli', { hook_event_name: 'stop' }), 'waiting')
  assert.equal(hookStatus('kiro-cli', { hook_event_name: 'preToolUse' }), null)
  await assert.rejects(hook('claude', { hook_event_name: 'Stop' }, {}), /agent-run/)
  const failOpen = spawnSync(process.execPath, [join(__dirname, 'agent-hook.cjs'), 'claude'], { input: '{malformed', encoding: 'utf8' })
  assert.equal(failOpen.status, 0); assert.equal(failOpen.stdout, '')
  assert.match(failOpen.stderr, /Focus tracker/)
  const privateMalformed = spawnSync(process.execPath, [join(__dirname, 'agent-hook.cjs'), 'claude'], { input: 'PRIVATE_MALFORMED_PAYLOAD', encoding: 'utf8' })
  assert.equal(privateMalformed.status, 0)
  assert.ok(!privateMalformed.stderr.includes('PRIVATE_MALFORMED_PAYLOAD'))
})

test('generated hook configurations use correct schemas and never enable hook caching', () => {
  const claude = configuration('claude'), kiro = configuration('kiro-cli')
  assert.equal(claude.hooks.UserPromptSubmit[0].hooks[0].type, 'command')
  assert.match(claude.hooks.UserPromptSubmit[0].hooks[0].command, /agent-hook.cjs/)
  assert.equal(kiro.hooks.userPromptSubmit[0].cache_ttl_seconds, 0)
  assert.equal(kiro.hooks.stop[0].timeout_ms, 3000)
})

test('Pi extension follows settlement, UI waits, session switches and shutdown', async () => {
  const client = require('./timeline-client.cjs'), original = client.sendEvent, sent = []
  client.sendEvent = async e => sent.push(e)
  try {
    const { default: extension } = await import('./integrations/pi-timeline.mjs')
    const handlers = {}
    extension({ on: (name, fn) => { handlers[name] = fn } })
    await handlers.session_start()
    await handlers.agent_start()
    assert.equal(handlers.agent_end, undefined)
    await handlers.ui_prompt_start(); await handlers.ui_prompt_end()
    await handlers.agent_settled(); await handlers.session_shutdown()
    await handlers.session_start(); await handlers.session_shutdown()
    assert.deepEqual(sent.map(e => e.status), ['waiting', 'working', 'waiting', 'working', 'waiting', 'stopped', 'waiting', 'stopped'])
    assert.notEqual(sent[0].session, sent.at(-1).session)
    assert.ok(sent.every(e => Object.keys(e).length === 4))
  } finally { client.sendEvent = original }
})

test('real collector serves timeline, enforces same-origin read-only HTTP, and persists IPC events', async () => {
  const directory = temporary()
  const server = await startServer({ directory, port: 0 })
  try {
    const url = `http://127.0.0.1:${server.port}`
    await sendEvent({ type: 'agent', agent: 'kiro-cli', session: 'synthetic', status: 'working' }, server.socketPath)
    await new Promise(r => setTimeout(r, 15))
    await sendEvent({ type: 'agent', agent: 'kiro-cli', session: 'synthetic', status: 'stopped' }, server.socketPath)
    const data = await (await fetch(`${url}/api/timeline`)).json()
    assert.ok(data.totals.agentMs > 0)
    assert.equal(data.spans[0].agent, 'kiro-cli')
    const humanEnd = Date.now()
    await sendEvent({ type: 'human', session: 'personal', status: 'tracking', app: 'Editor', start: humanEnd - 10, end: humanEnd }, server.socketPath)
    const agentView = await (await fetch(`${url}/api/timeline?agent=agents`)).json()
    assert.ok(agentView.spans.length > 0)
    assert.ok(agentView.spans.every(span => span.agent !== 'human'))
    assert.equal(agentView.totals.humanMs, 0)
    const personalView = await (await fetch(`${url}/api/timeline?agent=human`)).json()
    assert.ok(personalView.spans.length > 0)
    assert.ok(personalView.spans.every(span => span.agent === 'human'))
    assert.equal(personalView.totals.agentMs, 0)
    assert.equal((await fetch(url)).status, 200)
    assert.match(await (await fetch(`${url}/app.js`)).text(), /textContent/)
    assert.equal((await fetch(`${url}/api/timeline?from=100&to=0`)).status, 400)
    assert.equal((await fetch(`${url}/api/timeline?from=0&to=9999999999999`)).status, 400)
    assert.equal((await fetch(`${url}/api/timeline`, { headers: { Origin: 'https://other.example' } })).status, 403)
    // fetch normalizes Host; use a raw HTTP request to exercise rebinding checks.
    const wrongHost = await new Promise((resolve, reject) => {
      http.get(`${url}/api/timeline`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject)
    })
    assert.equal(wrongHost, 403)
    assert.equal((await fetch(`${url}/api/timeline`, { method: 'POST', body: '{}' })).status, 405)
    assert.equal((await fetch(`${url}/events.jsonl`)).status, 404)
    await assert.rejects(sendEvent({ type: 'invalid' }, server.socketPath), /Invalid event/)
    assert.equal(fs.statSync(server.socketPath).mode & 0o777, 0o600)
    await Promise.all(Array.from({ length: 20 }, (_, i) => sendEvent({ type: 'agent', agent: 'pi', session: `parallel-${i}`, status: 'working' }, server.socketPath)))
    assert.equal(server.store.events.filter(e => e.agent === 'pi').length, 20)
    const completeLines = fs.readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n')
    assert.ok(completeLines.every(line => JSON.parse(line).version === 1))
  } finally { await server.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('launcher and real hook subprocesses record background turns and preserve child exit status', async () => {
  const directory = temporary(), server = await startServer({ directory, port: 0 })
  try {
    const fixture = join(directory, 'agent-fixture.cjs')
    fs.writeFileSync(fixture, `const {spawnSync}=require('node:child_process');
      const hook=${JSON.stringify(join(__dirname, 'agent-hook.cjs'))};
      function emit(name){const r=spawnSync(process.execPath,[hook,'claude'],{input:JSON.stringify({hook_event_name:name,prompt:'PRIVATE_PROMPT'}),encoding:'utf8'});if(r.status!==0||r.stdout)process.exit(9)}
      emit('UserPromptSubmit');setTimeout(()=>{emit('Stop');process.exit(7)},30);`)
    const child = spawn(process.execPath, [join(__dirname, 'agent-run.cjs'), '--agent', 'claude', '--', process.execPath, fixture], { env: { ...process.env, FOCUS_TRACKER_SOCKET: server.socketPath }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', d => { stderr += d })
    const [code] = await once(child, 'exit')
    assert.equal(code, 7, stderr)
    assert.equal(stderr, '')
    const agents = server.store.events.filter(e => e.type === 'agent')
    assert.deepEqual(agents.map(e => e.status), ['waiting', 'working', 'waiting', 'stopped'])
    assert.equal(new Set(agents.map(e => e.session)).size, 1)
    assert.ok(!fs.readFileSync(join(directory, 'events.jsonl'), 'utf8').includes('PRIVATE_PROMPT'))
  } finally { await server.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('tracker CLI writes opt-in human timeline intervals without native desktop or titles', async () => {
  const directory = temporary(), server = await startServer({ directory, port: 0 })
  try {
    const fixture = join(directory, 'native.cjs')
    fs.writeFileSync(fixture, `exports.activeWindow=()=>({id:1,info:{name:'Synthetic Editor'},title:'PRIVATE_TITLE'}); exports.subscribeActiveWindow=()=>1;exports.unsubscribeActiveWindow=()=>{}`)
    const child = spawn(process.execPath, [join(__dirname, 'tracker.cjs'), '--no-state', '--no-activity', '--native', fixture, '--timeline-socket', server.socketPath, '--duration', '0.1', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d }); child.stderr.on('data', d => { stderr += d })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, stderr)
    assert.equal(stderr, '')
    assert.ok(JSON.parse(stdout).trackedMs > 0)
    const humans = server.store.events.filter(e => e.type === 'human')
    assert.ok(humans.some(e => e.app === 'Synthetic Editor'))
    assert.ok(humans.every(e => e.title === undefined))
    assert.ok(!fs.readFileSync(join(directory, 'events.jsonl'), 'utf8').includes('PRIVATE_TITLE'))
  } finally { await server.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})
