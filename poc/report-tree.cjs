'use strict'
const { processIcon } = require('./process-icons.cjs')

// No report data enters executable code. All labels are escaped by the renderer.
const script = `(() => {
  const tree = document.querySelector('.app-tree');
  const search = document.querySelector('#entry-search');
  const groups = [...tree.querySelectorAll('[data-app]')];
  let previousOpen;
  search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    if (query && !previousOpen) previousOpen = [...tree.querySelectorAll('details')].filter(d => d.open);
    let count = 0;
    for (const group of groups) {
      const parentMatches = group.querySelector('summary').textContent.toLocaleLowerCase().includes(query);
      const rows = [...group.querySelectorAll('[data-entry]')];
      for (const row of rows) row.hidden = !parentMatches && !row.textContent.toLocaleLowerCase().includes(query);
      for (const detail of group.querySelectorAll('details')) {
        const matches = detail.querySelector('summary').textContent.toLocaleLowerCase().includes(query);
        if (matches) for (const row of detail.querySelectorAll('[data-entry]')) row.hidden = false;
        detail.hidden = !parentMatches && !matches && ![...detail.querySelectorAll('[data-entry]')].some(row => !row.hidden);
      }
      group.hidden = !parentMatches && !rows.some(row => !row.hidden);
      if (!group.hidden) count++;
      if (query && !group.hidden) for (const detail of group.querySelectorAll('details')) detail.open = true;
      if (query && !group.hidden) group.open = true;
    }
    if (!query && previousOpen) {
      for (const detail of tree.querySelectorAll('details')) detail.open = previousOpen.includes(detail);
      previousOpen = undefined;
    }
    document.querySelector('#search-status').textContent = count + ' of ' + groups.length + ' applications';
    document.querySelector('#no-matches').hidden = count !== 0;
  });
  document.querySelector('#expand-all').addEventListener('click', () => {
    for (const detail of tree.querySelectorAll('details')) if (!detail.closest('[hidden]')) detail.open = true;
  });
  document.querySelector('#collapse-all').addEventListener('click', () => {
    for (const detail of tree.querySelectorAll('details')) detail.open = false;
  });
  const theme = document.querySelector('#theme-toggle');
  theme.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    theme.setAttribute('aria-pressed', String(dark));
    theme.textContent = dark ? 'Light theme' : 'Dark theme';
  });
  document.querySelector('.tree-tools').hidden = false;
})();`

const css = `
:root{color-scheme:light;--bg:#fff;--panel:#fff;--line:#e5e5e5;--text:#171717;--muted:#737373;--accent:#2563eb;--soft:#f5f5f5}

:root[data-theme=dark]{color-scheme:dark;--bg:#171717;--panel:#1c1c1c;--line:#363636;--text:#fafafa;--muted:#aaa;--accent:#60a5fa;--soft:#262626}

body{font-size:14px;line-height:1.5}
main{max-width:1152px;padding:28px 24px}
header{border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:24px;flex-wrap:wrap}
h1{font-size:28px;letter-spacing:-.035em;margin:8px 0}
h2{font-size:17px;margin-bottom:16px}
.eyebrow{color:var(--text);letter-spacing:0;text-transform:none;font-size:14px}
.badge{border-radius:6px;background:var(--soft);padding:5px 9px}
.cards{gap:12px}
.card,section{border-radius:8px}
.card{padding:16px 20px}
.card strong{font-size:25px}
section{padding:22px}
.overview{grid-template-columns:180px 1fr;gap:24px}
.donut{width:156px;height:156px}
.donut-inner{width:122px;height:122px}
.donut-inner strong{font-size:23px}
.bar,.bar span{border-radius:3px}
.dot{border-radius:2px}
button,input{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 12px}
button{cursor:pointer;white-space:nowrap}
button:hover{background:var(--soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.tree-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:18px 0}
.tree-tools input{flex:1;min-width:180px}
.tree-tools small{width:100%}
[hidden]{display:none!important}
.tree-head,.tree-row{display:grid;grid-template-columns:minmax(0,1fr) 100px 70px 110px;gap:14px;align-items:center;padding:12px 14px}
.tree-head{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:var(--soft)}
.app-tree{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.app-tree>details+details{border-top:1px solid var(--line)}
summary.tree-row{cursor:pointer;list-style:none;font-weight:600}
summary::-webkit-details-marker{display:none}
summary.tree-row:hover{background:var(--soft)}
.process-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-right:8px;vertical-align:-3px;color:var(--muted)}
.process-icon svg{display:block;width:16px;height:16px;flex-shrink:0}
.process-pi{font:19px/16px Georgia,serif}
.tree-name{min-width:0;overflow-wrap:anywhere}
.chevron{display:inline-block;width:20px;color:var(--muted)}
.chevron:before{content:'›'}
details[open]>summary .chevron:before{content:'⌄'}
.tree-children{margin:0 14px 12px 24px;border-left:1px solid var(--line)}
.tree-children .tree-row{padding-left:18px;font-size:13px}
.tree-section{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:14px 18px 4px}
.tree-row .bar{width:100%;background:var(--soft)}
.tree-row .bar span{background:var(--accent)}
.tree-note{margin:12px 0 0;font-size:12px;color:var(--muted)}
.tree-empty{padding:14px;color:var(--muted)}
.supporting>summary{cursor:pointer;font-size:16px;font-weight:600}
.supporting[open]>summary{margin-bottom:18px}
.supporting{margin:0}
.tree-row small{font-weight:400;font-size:11px;color:var(--muted)}

@media(max-width:760px){main{padding:20px 14px}
.overview{grid-template-columns:1fr}
.tree-head,.tree-row{grid-template-columns:minmax(0,1fr) 78px 48px;gap:8px;padding:12px 10px}
.tree-row .bar,.tree-head>:last-child{display:none}
.tree-children{margin-left:14px;margin-right:6px}
.tree-tools button{flex:1}
section{padding:16px}
.card{padding:14px}
.card strong{font-size:21px}
}

@media print{.tree-tools{display:none!important}
:root{--bg:#fff;--panel:#fff;--text:#111;--muted:#555;--line:#ddd;--soft:#f5f5f5}
.app-tree{overflow:visible}
.tree-row{break-inside:avoid}
}

`

function renderTree(report, escape, duration) {
  const percent = ms => report.trackedMs > 0 ? ms / report.trackedMs * 100 : 0
  const cells = ms => `<span class="number">${duration(ms)}</span><span class="number muted">${percent(ms).toFixed(1)}%</span><span class="bar" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, percent(ms))).toFixed(4)}%"></span></span>`
  const leaf = (label, ms, process = false) => `<div class="tree-row" data-entry><span class="tree-name">${process ? processIcon(label) : ''}${escape(label)}</span>${cells(ms)}</div>`
  const groups = report.apps.map(([app, ms]) => {
    const titles = report.titlesEnabled ? (report.details || []).filter(row => row.app === app) : []
    const terminals = report.footEnabled ? (report.terminals || []).filter(row => row.app === app) : []
    const executables = terminals.map(row => {
      const labels = report.titlesEnabled && row.executable ? (report.agentLabels || []).filter(label => label.app === app && label.executable === row.executable) : []
      const name = row.executable || `Unknown — ${row.reason || 'unavailable'}`
      return labels.length ? `<details><summary class="tree-row"><span class="tree-name"><span class="chevron" aria-hidden="true"></span>${processIcon(row.executable)}${escape(name)}</span>${cells(row.ms)}</summary><div class="tree-children"><div class="tree-section">Observed agent labels</div>${labels.map(label => leaf(label.label, label.ms)).join('')}</div></details>` : leaf(name, row.ms, true)
    }).join('')
    const children = `${terminals.length ? `<div class="tree-section">Foreground executables</div>${executables}` : ''}${titles.length ? `<div class="tree-section">Observed window titles · separate breakdown</div>${titles.map(row => leaf(row.title, row.ms)).join('')}` : ''}`
    return `<details data-app open><summary class="tree-row"><span class="tree-name"><span class="chevron" aria-hidden="true"></span>${processIcon(app)}${escape(app)}</span>${cells(ms)}</summary><div class="tree-children">${children || '<p class="tree-empty">No detail observations recorded for this application.</p>'}</div></details>`
  }).join('')
  return `<section aria-labelledby="tree-title"><h2 id="tree-title">Application tree</h2><p class="muted">Explore applications, foreground executables and observed titles.</p><div class="tree-tools" hidden><label class="muted" for="entry-search">Search</label><input id="entry-search" type="search" placeholder="Applications, executables, titles…" autocomplete="off"><button id="expand-all" type="button">Expand all</button><button id="collapse-all" type="button">Collapse all</button><button id="theme-toggle" type="button" aria-pressed="false">Dark theme</button><small id="search-status" role="status" aria-live="polite">${report.apps.length} of ${report.apps.length} applications</small></div><div class="app-tree"><div class="tree-head"><span>Application / detail</span><span class="number">Time</span><span class="number">Share</span><span></span></div>${groups || '<p class="tree-empty">No foreground time recorded.</p>'}<p class="tree-empty" id="no-matches" hidden>No matching applications or details.</p></div><p class="tree-note">Shares use total tracked foreground time. Executables and window titles are separate, overlapping breakdowns; do not add them together. Agent labels cover correlated observations only. Expanding or filtering never changes recorded totals.</p><noscript><p class="tree-note">Application groups can be expanded without JavaScript. Search, theme and bulk controls require JavaScript.</p></noscript></section>`
}
module.exports = { renderTree, css, script }
