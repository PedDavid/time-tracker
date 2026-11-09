'use strict'
// Generates only synthetic data, never contacts Hyprland or loads the native addon.
const { resolve } = require('node:path')
const { writeHtml } = require('./html-report.cjs')
const minute = 60_000
const path = resolve(process.argv[2] || 'poc/example-report.html')
writeHtml(path, {
  synthetic: true,
  startedAt: '2026-01-01T09:00:00Z',
  elapsedMs: 75 * minute,
  trackedMs: 60 * minute,
  apps: [['librewolf', 30 * minute], ['foot', 20 * minute], ['fixture.Editor', 10 * minute]],
  excluded: [['paused', 10 * minute], ['no focus', 4 * minute], ['IPC unavailable', minute]],
  titlesEnabled: true,
  details: [
    { app: 'foot', title: 'foot (synthetic window title, not an inner process)', ms: 20 * minute },
    { app: 'librewolf', title: 'Hyprland documentation — LibreWolf', ms: 18 * minute },
    { app: 'librewolf', title: 'Synthetic issue tracker — LibreWolf', ms: 12 * minute },
    { app: 'fixture.Editor', title: 'report.cjs — Example project', ms: 10 * minute },
  ],
  errors: 1,
})
console.log(`Synthetic example report saved: ${path}`)
