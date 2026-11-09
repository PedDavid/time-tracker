'use strict'

const { writeFileSync } = require('node:fs')

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}
function duration(ms) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
const colors = ['#a6a1ff', '#63d5c4', '#f3bb77', '#ef93bb', '#77b8f1', '#c5dc8b', '#e4a1ee', '#8dd9ea', '#8490a7']

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
  const date = report.startedAt ? escapeHtml(new Date(report.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })) : 'Local session'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Focus time · Local session</title>
<style>
:root{color-scheme:dark;--bg:#101522;--panel:#192133;--line:#2b364c;--text:#ecf0fa;--muted:#a3afc5;--accent:#a6a1ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,sans-serif}main{max-width:1100px;margin:auto;padding:56px 28px}header{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-bottom:36px}.eyebrow{color:var(--accent);text-transform:uppercase;letter-spacing:.18em;font-size:11px;font-weight:700}h1{font-size:clamp(30px,5vw,48px);line-height:1.15;letter-spacing:-.04em;margin:10px 0}h2{font-size:19px;letter-spacing:-.02em;margin:0 0 20px}p{margin:8px 0}.muted,small{color:var(--muted)}.badge{border:1px solid var(--line);border-radius:30px;padding:8px 14px;font-size:12px;white-space:nowrap}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}.card,section{background:var(--panel);border:1px solid var(--line);border-radius:18px}.card{padding:22px}.card strong{display:block;font-size:27px;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.card small{font-size:12px}section{padding:28px;margin-bottom:24px}.overview{display:grid;grid-template-columns:240px 1fr;gap:36px;align-items:center}.donut{width:204px;height:204px;border-radius:50%;display:grid;place-items:center;margin:12px auto;background:${chart}}.donut-inner{background:var(--panel);width:152px;height:152px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column}.donut-inner strong{font-size:26px}.donut-inner small{font-size:11px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:500}td,th{padding:13px 8px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}.number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.dot{width:9px;height:9px;display:inline-block;border-radius:3px;margin-right:10px}.bar-cell{width:25%}.bar{height:5px;border-radius:8px;background:var(--line);overflow:hidden}.bar span{display:block;height:100%;border-radius:8px}.title{min-width:220px;overflow-wrap:anywhere}.notice{border-left:3px solid var(--accent);padding:4px 0 4px 18px;font-size:13px;color:var(--muted)}footer{font-size:12px;color:var(--muted);margin-top:28px}.empty{color:var(--muted);padding:16px 0} @media(max-width:760px){main{padding:28px 16px}header{align-items:flex-start}.cards{grid-template-columns:repeat(2,1fr)}.overview{grid-template-columns:1fr;gap:16px}section{padding:20px}.bar-cell{display:none}.badge{white-space:normal}.card strong{font-size:23px}} @media print{body{background:#fff;color:#111;--text:#111;--muted:#555;--panel:#fff;--line:#ddd}main{padding:0}section,.card{break-inside:avoid}.donut{print-color-adjust:exact}.bar,.dot{print-color-adjust:exact}}
</style></head><body><main>
<header><div><div class="eyebrow">Focus journal / local PoC</div><h1>A little clarity<br>on your time.</h1><p class="muted">${date} · Foreground-window summary</p></div><span class="badge">${report.synthetic ? 'Synthetic demo · ' : ''}Offline report · No external assets</span></header>
<div class="cards"><div class="card"><small>Session elapsed</small><strong>${duration(elapsedMs)}</strong></div><div class="card"><small>Foreground time</small><strong>${duration(trackedMs)}</strong></div><div class="card"><small>Excluded time</small><strong>${duration(excludedMs)}</strong></div><div class="card"><small>Applications</small><strong>${apps.length}</strong></div></div>
<section><h2>Where your focus went</h2><div class="overview"><div class="donut" role="img" aria-label="Application shares of tracked foreground time; values in adjacent table"><div class="donut-inner"><strong>${percent(trackedMs, elapsedMs).toFixed(0)}%</strong><small>of elapsed time tracked</small></div></div><div class="table-wrap"><table><thead><tr><th>Application</th><th class="bar-cell"></th><th class="number">Time</th><th class="number">Share</th></tr></thead><tbody>${appRows || '<tr><td colspan="4" class="empty">No foreground time recorded.</td></tr>'}</tbody></table><small>Shares are relative to tracked time, not total elapsed time.</small></div></div></section>
<section><h2>Window-title breakdown</h2>${report.titlesEnabled ? `<p class="muted">Opt-in window titles, not verified browser URLs or terminal commands. May contain private information.</p><div class="table-wrap"><table><thead><tr><th>Application</th><th>Observed window title</th><th class="number">Time</th><th class="number">Share</th></tr></thead><tbody>${detailRows || '<tr><td colspan="4" class="empty">No title observations recorded.</td></tr>'}</tbody></table></div>` : '<p class="muted">Title collection was off. Run with <code>--titles</code> to opt in for future sessions. Past titles cannot be reconstructed.</p>'}</section>
<section><h2>Time left out</h2><div class="table-wrap"><table><tbody>${excludedRows || '<tr><td class="empty">No excluded time.</td></tr>'}</tbody></table></div><p class="muted">IPC outage notifications: ${Number(report.errors) || 0}. Paused, no-focus and unavailable periods are not attributed.</p></section>
<div class="notice"><strong>Foreground time is not proof of active work.</strong> Idle and session lock are not detected. Pause manually before stepping away. Terminal foreground commands and browser URLs are not resolved. Window titles are app-provided text, not authoritative process attribution.</div>
<footer>Generated locally. No scripts, fonts, analytics or network requests. This file contains application names${report.titlesEnabled ? ' and opt-in window titles' : ''}; treat it as private. Time values are rounded down to whole seconds.</footer>
</main></body></html>`
}

function writeHtml(path, report) {
  // Exclusive creation avoids accidental overwrites and following an existing symlink.
  writeFileSync(path, renderHtml(report), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

module.exports = { renderHtml, writeHtml }
