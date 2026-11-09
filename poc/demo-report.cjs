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
  excluded: [['paused', 5 * minute], ['idle', 4 * minute], ['locked', 3 * minute], ['activity-unavailable', minute], ['no focus', minute], ['IPC unavailable', minute]],
  activityDetection: {
    enabled: true, idleTimeoutMs: 300000, historyComplete: true, status: 'active',
    idleSource: 'ext-idle-notify-v2-input', lockSource: 'hyprland-monitors-solitary',
    lockScope: 'hyprland-0.56.2-polled',
  },
  checkpoint: { asOf: '2026-01-01T10:15:00.000Z', timeSource: 'savedAt' },
  titlesEnabled: true,
  details: [
    { app: 'foot', title: 'π - Synthetic tracker task', ms: 8 * minute },
    { app: 'foot', title: 'Claude — Synthetic infra task', ms: 6 * minute },
    { app: 'foot', title: 'foot (synthetic window title)', ms: 6 * minute },
    { app: 'librewolf', title: 'Hyprland documentation — LibreWolf', ms: 18 * minute },
    { app: 'librewolf', title: 'Synthetic issue tracker — LibreWolf', ms: 12 * minute },
    { app: 'fixture.Editor', title: 'report.cjs — Example project', ms: 10 * minute },
  ],
  footEnabled: true,
  terminals: [
    { app: 'foot', executable: 'pi', reason: null, ms: 8 * minute },
    { app: 'foot', executable: 'claude', reason: null, ms: 6 * minute },
    { app: 'foot', executable: 'nvim', reason: null, ms: 4 * minute },
    { app: 'foot', executable: null, reason: 'multiple-foreground-roots', ms: 2 * minute },
  ],
  agentLabels: [
    { app: 'foot', executable: 'pi', label: 'π - Synthetic tracker task', source: 'window-title', ms: 8 * minute },
    { app: 'foot', executable: 'claude', label: 'Claude — Synthetic infra task', source: 'window-title', ms: 6 * minute },
  ],
  errors: 1,
})
console.log(`Synthetic example report saved: ${path}`)
