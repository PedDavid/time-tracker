'use strict'

const { writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const tree = require('./report-tree.cjs')
const scriptHash = createHash('sha256').update(tree.script).digest('base64')

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}
function duration(ms) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
const colors = ['#2563eb', '#0d9488', '#d97706', '#db2777', '#7c3aed', '#65a30d', '#c026d3', '#0891b2', '#737373']

function renderHtml(report) {
  const { apps, excluded, trackedMs, elapsedMs, details = [] } = report
  const excludedMs = excluded.reduce((sum, [, ms]) => sum + ms, 0)
  const percent = (ms, total = trackedMs) => total > 0 ? ms / total * 100 : 0
  const chartApps = apps.slice(0, 8)
  if (apps.length > 8) chartApps.push(['Other applications', apps.slice(8).reduce((sum, [, ms]) => sum + ms, 0)])
  let position = 0
  const slices = chartApps.map(([, ms], index) => {
    const start = position
    position += percent(ms)
    return `${colors[index]} ${start.toFixed(4)}% ${position.toFixed(4)}%`
  })
  const chart = trackedMs > 0 && slices.length ? `conic-gradient(${slices.join(',')})` : '#313b51'
  const appRows = apps.map(([app, ms], index) => `<tr><td><span class="dot" style="background:${colors[index < 8 ? index : 8]}"></span>${escapeHtml(app)}</td><td class="bar-cell"><div class="bar"><span style="width:${percent(ms).toFixed(4)}%;background:${colors[index < 8 ? index : 8]}"></span></div></td><td class="number">${duration(ms)}</td><td class="number muted">${percent(ms).toFixed(1)}%</td></tr>`).join('')
  const excludedRows = excluded.map(([kind, ms]) => `<tr><td>${escapeHtml(kind)}</td><td class="number">${duration(ms)}</td><td class="number muted">${percent(ms, elapsedMs).toFixed(1)}% of elapsed</td></tr>`).join('')
  const detailRows = details.map(({ app, title, ms }) => `<tr><td class="muted">${escapeHtml(app)}</td><td class="title">${escapeHtml(title)}</td><td class="number">${duration(ms)}</td><td class="number muted">${percent(ms).toFixed(1)}%</td></tr>`).join('')
  const terminalTotal = (report.terminals || []).reduce((sum, row) => sum + row.ms, 0)
  const terminalRows = (report.terminals || []).map(({ app, executable, reason, ms }) => `<tr><td class="muted">${escapeHtml(app)}</td><td>${escapeHtml(executable || `Unknown — ${reason}`)}</td><td class="number">${duration(ms)}</td><td class="number muted">${percent(ms, terminalTotal).toFixed(1)}%</td></tr>`).join('')
  const agentRows = (report.agentLabels || []).map(({ executable, label, ms }) => `<tr><td>${escapeHtml(executable)}</td><td class="title">${escapeHtml(label)}</td><td class="number">${duration(ms)}</td></tr>`).join('')
  const date = report.startedAt ? escapeHtml(new Date(report.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })) : 'Local session'
  const activity = report.activityDetection
  const activityNotice = activity?.enabled === true
    ? `Automatic idle/lock gating was enabled at this snapshot; signal: ${escapeHtml(activity.status || report.activity || 'unrecorded')}. Input-idle cutoff: ${duration(activity.idleTimeoutMs)}; pre-cutoff grace is counted. Unavailable signals exclude time. Lock detection is polled and reviewed for Hyprland 0.56.2 only.${activity.historyComplete === false ? ' Earlier history was not fully gated.' : ''}`
    : activity?.enabled === false
      ? 'Automatic idle/lock gating was explicitly disabled. Pause manually before leaving or locking.'
      : report.checkpoint
        ? 'No automatic activity policy was recorded. Export does not query idle or session-lock status.'
        : 'No automatic activity policy was recorded. Pause manually before leaving or locking.'
  const detectionMetadata = Object.fromEntries(['activityDetection', 'idleDetection', 'lockDetection', 'detection'].filter((key) => Object.hasOwn(report, key)).map((key) => [key, report[key]]))
  const checkpointSection = report.checkpoint ? `<section><h2>Checkpoint snapshot</h2><p>Checkpoint as of <time datetime="${escapeHtml(report.checkpoint.asOf)}">${escapeHtml(report.checkpoint.asOf)}</time> (${report.checkpoint.timeSource === 'savedAt' ? 'saved-at timestamp' : 'file modification time; saved-at timestamp absent'}).</p><p class="notice">Latest saved snapshot only, typically 5 seconds behind the tracker, plus scheduling/I/O delay. This is not a live query. It can be much older if tracking stopped or saves failed. No time after this snapshot was added by export.</p>${Object.keys(detectionMetadata).length ? `<details><summary>Saved idle/lock detection metadata (not queried by export)</summary><pre>${escapeHtml(JSON.stringify(detectionMetadata, null, 2))}</pre></details>` : '<p class="muted">No idle/lock detection capability metadata was recorded in this checkpoint.</p>'}</section>` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'">
<title>Focus time · Local session</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif}
main{margin:auto}
header{display:flex;justify-content:space-between;gap:24px;align-items:center}
p{margin:8px 0}
.muted,small{color:var(--muted)}
.badge{border:1px solid var(--line);font-size:12px;white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:24px}
.card,section{background:var(--panel);border:1px solid var(--line)}
.card strong{display:block;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.card small{font-size:12px}
section{margin-bottom:24px}
.overview{display:grid;align-items:center}
.donut{border-radius:50%;display:grid;place-items:center;margin:12px auto;background:${chart}}
.donut-inner{background:var(--panel);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column}
.donut-inner small{font-size:11px}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:500}
td,th{padding:13px 8px;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.dot{width:9px;height:9px;display:inline-block;margin-right:10px}
.bar-cell{width:25%}
.bar{height:5px;background:var(--line);overflow:hidden}
.bar span{display:block;height:100%}
.title{min-width:220px;overflow-wrap:anywhere}
.notice{border-left:3px solid var(--accent);padding:4px 0 4px 18px;font-size:13px;color:var(--muted)}
footer{font-size:12px;color:var(--muted);margin-top:28px}
.empty{color:var(--muted);padding:16px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:760px){header{align-items:flex-start}.cards{grid-template-columns:repeat(2,1fr)}.bar-cell{display:none}.badge{white-space:normal}}
@media print{body{background:#fff;color:#111}main{padding:0}section,.card{break-inside:avoid}.donut,.bar,.dot{print-color-adjust:exact}}
${tree.css}
</style></head><body><main>
<header><div><div class="eyebrow">◷ time-tracker</div><h1>Your time, at a glance.</h1><p class="muted">${date} · Foreground-window summary</p></div><span class="badge">${report.synthetic ? 'Synthetic demo · ' : ''}Offline report · No external assets</span></header>
<div class="cards"><div class="card"><small>Session elapsed</small><strong>${duration(elapsedMs)}</strong></div><div class="card"><small>Foreground time</small><strong>${duration(trackedMs)}</strong></div><div class="card"><small>Excluded time</small><strong>${duration(excludedMs)}</strong></div><div class="card"><small>Applications</small><strong>${apps.length}</strong></div></div>
${tree.renderTree(report, escapeHtml, duration)}
${checkpointSection}
<section><details class="supporting"><summary>Application overview</summary><div class="overview"><div class="donut" role="img" aria-label="Application shares of tracked foreground time; values in adjacent table"><div class="donut-inner"><strong>${percent(trackedMs, elapsedMs).toFixed(0)}%</strong><small>of elapsed time tracked</small></div></div><div class="table-wrap"><table><thead><tr><th>Application</th><th class="bar-cell"></th><th class="number">Time</th><th class="number">Share</th></tr></thead><tbody>${appRows || '<tr><td colspan="4" class="empty">No foreground time recorded.</td></tr>'}</tbody></table><small>Shares are relative to tracked time, not total elapsed time.</small></div></div></details></section>
<section><details class="supporting"><summary>Window-title breakdown</summary>${report.titlesEnabled ? `<p class="muted">Opt-in window titles, not verified browser URLs or terminal commands. May contain private information.</p><div class="table-wrap"><table><thead><tr><th>Application</th><th>Observed window title</th><th class="number">Time</th><th class="number">Share</th></tr></thead><tbody>${detailRows || '<tr><td colspan="4" class="empty">No title observations recorded.</td></tr>'}</tbody></table></div>` : '<p class="muted">Title collection was off. Run with <code>--titles</code> to opt in for future sessions. Past titles cannot be reconstructed.</p>'}</details></section>
<section><details class="supporting"><summary>foot foreground executables</summary>${report.footEnabled ? `<p class="muted">Opt-in PTY/foreground-group snapshots. Application totals remain unchanged; these rows subdivide observed foot time, including unknowns. No command arguments, projects, remote SSH commands or tmux panes are inferred.</p><div class="table-wrap"><table><thead><tr><th>Application</th><th>Executable / unknown reason</th><th class="number">Time</th><th class="number">Share of foot</th></tr></thead><tbody>${terminalRows || '<tr><td colspan="4" class="empty">No foot foreground observations recorded.</td></tr>'}</tbody></table></div>` : '<p class="muted">Foot command tracking was off. Use <code>--foot</code> to opt in for future sessions.</p>'}</details></section>
<section><details class="supporting"><summary>Agent session labels</summary>${report.footEnabled && report.titlesEnabled ? `<p class="muted">Pi/Claude foreground executables correlated with observed window titles. A named session may appear here, but these are literal title-derived labels, not verified session names or IDs. Decorations can split entries and identical titles merge. Labels wait for a matching process observation after title changes.</p><div class="table-wrap"><table><thead><tr><th>Agent</th><th>Observed title / session label</th><th class="number">Time</th></tr></thead><tbody>${agentRows || '<tr><td colspan="3" class="empty">No correlated pi/Claude title observations. Name a session in the agent and focus its foot window.</td></tr>'}</tbody></table></div>` : '<p class="muted">Enable both <code>--foot --titles</code> for title-derived pi/Claude session labels in future observations.</p>'}</details></section>
<section><h2>Time left out</h2><div class="table-wrap"><table><tbody>${excludedRows || '<tr><td class="empty">No excluded time.</td></tr>'}</tbody></table></div><p class="muted">IPC outage notifications: ${Number(report.errors) || 0}. Paused, no-focus, idle, locked and unavailable periods are not attributed when their gates are enabled.</p></section>
<div class="notice"><strong>Foreground time is not proof of active work.</strong> ${activityNotice} Activity policy describes the current run, not necessarily all resumed history; boundaries have polling/delivery latency. Browser URLs are not resolved. Foot executable attribution requires opt-in and a provable PTY association; ambiguous cases are unknown. Window titles are app-provided text, not authoritative process attribution.</div>
<footer>Generated locally. Embedded report controls only; no external scripts, fonts, analytics or network requests. This file contains application names${report.titlesEnabled ? ' and opt-in window titles' : ''}${report.footEnabled ? ' and opt-in foreground executable names' : ''}; treat it as private. Time values are rounded down to whole seconds. Claude and LibreWolf icons: selfh.st/icons, CC BY 4.0; embedded SVGs adapted for HTML.</footer>
</main><script>${tree.script}</script></body></html>`
}

function writeHtml(path, report) {
  // Exclusive creation avoids accidental overwrites and following an existing symlink.
  writeFileSync(path, renderHtml(report), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

module.exports = { renderHtml, writeHtml }
