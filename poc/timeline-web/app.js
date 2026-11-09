'use strict'
const $ = id => document.getElementById(id)
const state = { duration: 86400000, end: Date.now(), data: null, selected: null, request: 0, view: 'person' }
const processIcons = new Map()
// Only the server's fixed, reviewed icon catalog is parsed as markup. Activity
// labels remain text and never enter SVG, HTML, URLs, or filesystem paths.
const iconsReady = fetch('/api/process-icons').then(response => {
  if (!response.ok) throw new Error('Icon catalog unavailable')
  return response.json()
}).then(catalog => {
  for (const [name, markup] of Object.entries(catalog)) {
    const icon = new DOMParser().parseFromString(markup, 'text/html').body.firstElementChild
    if (icon) processIcons.set(name, icon)
  }
}).catch(() => {})
function processIcon(name) {
  const icon = processIcons.get(String(name).toLowerCase()) || processIcons.get('default')
  if (icon) return icon.cloneNode(true)
  const fallback = element('span', '□', 'process-icon')
  fallback.setAttribute('aria-hidden', 'true')
  return fallback
}
$('theme-toggle').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  $('theme-toggle').setAttribute('aria-pressed', String(dark))
  $('theme-toggle').textContent = dark ? 'Light theme' : 'Dark theme'
}
const formatDuration = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ${s % 60}s` }
const formatDate = ms => new Date(ms).toLocaleString()
function element(tag, text, className) {
  const el = document.createElement(tag)
  if (text !== undefined) el.textContent = text
  if (className) el.className = className
  return el
}
function inspect(span) {
  const panel = $('inspector')
  panel.replaceChildren(element('h2', 'Span details'))
  if (!span) { panel.append(element('p', 'Select a span to inspect its actor, activity, start, end and duration.')); return }
  state.selected = span.id
  const list = element('dl')
  const entries = [ ['Actor', span.agent === 'human' ? 'You' : span.agent], ['Session', span.session], ['Activity', span.status], ['Start', formatDate(span.start)], ['End', formatDate(span.end)], ['Duration in range', formatDuration(span.end - span.start)] ]
  if (span.app) entries.push(['Application', span.app])
  if (span.title) entries.push(['Window title (opt-in)', span.title])
  if (span.interrupted) entries.push(['Continuity', 'Interrupted or missing heartbeat. Unknown time is excluded from execution totals.'])
  for (const [key, value] of entries) list.append(element('dt', key), element('dd', value))
  panel.append(list)
  document.querySelectorAll('.span').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.id === state.selected)))
}
function render(data) {
  $('human-total').textContent = formatDuration(data.totals.humanMs)
  $('agent-total').textContent = formatDuration(data.totals.agentMs)
  $('waiting-total').textContent = formatDuration(data.totals.waitingMs)
  $('range-label').textContent = `${formatDate(data.from)} — ${formatDate(data.to)}`
  $('notice').textContent = data.truncated ? 'More than 10,000 spans match. Showing the newest; narrow the range. Totals include all matching spans.' : ''
  const timeline = $('timeline')
  timeline.replaceChildren()
  $('empty').hidden = data.spans.length > 0
  if (!data.spans.length) { inspect(null); return }
  const axis = element('div', undefined, 'axis'), ticks = element('div', undefined, 'ticks')
  axis.append(element('div'), ticks)
  for (let i = 0; i < 5; i++) ticks.append(element('span', new Date(data.from + (data.to - data.from) * i / 4).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
  timeline.append(axis)
  const lanes = new Map()
  for (const span of data.spans) {
    if (!lanes.has(span.actor)) lanes.set(span.actor, [])
    lanes.get(span.actor).push(span)
  }
  for (const [, spans] of [...lanes].sort(([a], [b]) => a.localeCompare(b))) {
    const first = spans[0], lane = element('div', undefined, 'lane')
    const label = element('div', undefined, 'lane-label')
    if (first.agent !== 'human') label.append(processIcon(first.agent))
    label.append(element('span', first.agent === 'human' ? 'You' : first.agent), element('small', `session ${first.session.slice(0, 8)}`))
    const tracks = new Map()
    for (const span of spans) {
      const name = span.agent === 'human' && span.status === 'tracking' ? span.app : span.status
      const key = JSON.stringify([span.status, name])
      if (!tracks.has(key)) tracks.set(key, { name, status: span.status, spans: [] })
      tracks.get(key).spans.push(span)
    }
    lane.append(label)
    const order = ['tracking', 'working', 'waiting', 'paused', 'idle', 'locked', 'no focus', 'IPC unavailable', 'activity-unavailable', 'unknown']
    const rows = [...tracks.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name))
    for (const row of rows) {
      const subtrack = element('div', undefined, 'subtrack')
      const trackLabel = element('div', undefined, 'subtrack-label')
      if (first.agent === 'human' && row.status === 'tracking') trackLabel.append(processIcon(row.name))
      trackLabel.append(element('span', row.name, 'subtrack-name'))
      trackLabel.title = row.name
      const track = element('div', undefined, 'track')
      for (const span of row.spans) {
        const name = span.app || span.status
        const button = element('button', undefined, 'span')
        button.style.left = `${100 * (span.start - data.from) / (data.to - data.from)}%`
        button.style.width = `${100 * (span.end - span.start) / (data.to - data.from)}%`
        button.dataset.status = span.status; button.dataset.id = span.id
        button.setAttribute('aria-label', `${first.agent === 'human' ? 'You' : first.agent}: ${name}, ${formatDuration(span.end - span.start)}, ${formatDate(span.start)}`)
        button.setAttribute('aria-pressed', String(span.id === state.selected))
        button.title = `${name} · ${formatDuration(span.end - span.start)}`
        button.onclick = () => inspect(span)
        track.append(button)
      }
      subtrack.append(trackLabel, track)
      lane.append(subtrack)
    }
    timeline.append(lane)
  }
  inspect(data.spans.find(s => s.id === state.selected) || null)
}
async function refresh() {
  if ($('live').checked) state.end = Date.now()
  const sequence = ++state.request
  const params = new URLSearchParams({ from: Math.round(state.end - state.duration), to: Math.round(state.end), agent: state.view === 'person' ? 'human' : $('agent').value, status: $('status').value })
  try {
    const response = await fetch(`/api/timeline?${params}`)
    if (!response.ok) throw new Error('Timeline request failed')
    const data = await response.json()
    await iconsReady
    if (sequence !== state.request) return
    state.data = data
    $('connection').textContent = $('live').checked ? 'Live · every 5s' : 'Connected · fixed range'
    $('dot').classList.add('connected')
    render(data)
  } catch {
    if (sequence !== state.request) return
    $('connection').textContent = 'Disconnected · retrying'
    $('dot').classList.remove('connected')
    $('notice').textContent = 'Could not load the timeline. Check that the local collector is running. Displayed data may be stale.'
  }
}
function switchView(view) {
  state.view = view
  state.selected = null
  state.data = null
  $('timeline').replaceChildren()
  inspect(null)
  const personal = view === 'person'
  $('view-person').setAttribute('aria-pressed', String(personal))
  $('view-agents').setAttribute('aria-pressed', String(!personal))
  $('agent-filter').hidden = personal
  $('human-metric').hidden = !personal
  $('agent-metric').hidden = personal
  $('waiting-metric').hidden = personal
  $('agent-note').hidden = personal
  $('trace-title').textContent = personal ? 'Your activity' : 'Agent activity'
  $('legend-active').textContent = personal ? 'Focused' : 'Working'
  $('empty-title').textContent = personal ? 'No personal activity in this range' : 'No agent activity in this range'
  $('empty-help').textContent = personal ? 'Start the focus tracker with --timeline to record your activity.' : 'Connect Claude, Pi or Kiro using the integration guide to record agent tasks.'
  const filters = personal
    ? [['', 'All activity'], ['tracking', 'Focused'], ['paused', 'Paused'], ['idle', 'Idle'], ['locked', 'Locked'], ['waiting', 'Waiting'], ['activity-unavailable', 'Activity unavailable'], ['IPC unavailable', 'IPC unavailable'], ['no focus', 'No focus']]
    : [['', 'All activity'], ['working', 'Working'], ['waiting', 'Waiting'], ['unknown', 'Unknown / interrupted']]
  $('status').replaceChildren(...filters.map(([value, text]) => { const option = element('option', text); option.value = value; return option }))
  void refresh()
}
$('view-person').onclick = () => switchView('person')
$('view-agents').onclick = () => switchView('agents')
for (const id of ['agent', 'status', 'live']) $(id).onchange = refresh
$('range').onchange = () => { state.duration = Number($('range').value); void refresh() }
$('previous').onclick = () => { $('live').checked = false; state.end = Math.max(state.duration, state.end - state.duration); void refresh() }
$('next').onclick = () => { $('live').checked = false; state.end += state.duration; void refresh() }
$('zoom-in').onclick = () => { state.duration = Math.max(60000, state.duration / 2); void refresh() }
$('zoom-out').onclick = () => { state.duration = Math.min(31 * 86400000, state.duration * 2); void refresh() }
$('dates').onsubmit = event => {
  event.preventDefault()
  const from = new Date($('from').value).getTime(), to = new Date($('to').value).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 31 * 86400000) { $('notice').textContent = 'Choose an increasing date range of up to 31 days.'; return }
  state.end = to; state.duration = to - from; $('live').checked = false; void refresh()
}
$('export').onclick = () => {
  if (!state.data) return
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob), link = element('a')
  link.href = url; link.download = 'focus-timeline.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
switchView('person')
setInterval(() => { if (!document.hidden) void refresh() }, 5000)
