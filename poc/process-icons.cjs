'use strict'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
// Only fixed, reviewed assets are loaded. Process labels never become paths or SVG.
const brands = Object.fromEntries(['claude', 'librewolf'].map(name => [name,
  readFileSync(join(__dirname, 'icons', `${name}.svg`), 'utf8').trim()
    .replace(/ xmlns="[^"]*"| xml:space="[^"]*"/g, '')
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" '),
]))
const drawing = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" focusable="false">${paths}</svg>`
const terminal = drawing('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>')
const code = drawing('<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/>')
const generic = drawing('<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="12" cy="12" r="2"/>')
function processIcon(name) {
  const key = String(name || '').toLowerCase()
  const fallback = { foot: terminal, 'foot-client': terminal, nvim: code, neovim: code,
    pi: '<span class="process-pi">π</span>', 'fixture.editor': code }
  const svg = Object.hasOwn(brands, key) ? brands[key] : Object.hasOwn(fallback, key) ? fallback[key] : generic
  return `<span class="process-icon" aria-hidden="true">${svg}</span>`
}
module.exports = { processIcon }
