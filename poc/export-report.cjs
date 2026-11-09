#!/usr/bin/env node
'use strict'

const { realpathSync } = require('node:fs')
const { resolve, join, dirname, basename } = require('node:path')
const { homedir } = require('node:os')
const { readCheckpoint } = require('./checkpoint-reader.cjs')
const { writeHtml } = require('./html-report.cjs')

const HELP = `Read-only export of the latest saved focus-tracker checkpoint
Usage: node poc/export-report.cjs [--state PATH] --html NEWFILE [--titles] [--foot]
  --state PATH   Existing checkpoint (default: XDG_STATE_HOME/focus-tracker/session.json
                 or ~/.local/state/focus-tracker/session.json)
  --html NEWFILE  New private HTML file; existing files/symlinks are never overwritten
  --titles       Explicit consent to saved private titles; must match checkpoint policy
  --foot         Explicit consent to saved foot data; must match checkpoint policy
  --help, -h     Show this help
Exports saved totals only: typically 5 seconds behind, possibly much older.
No live query, writer lock, native addon, compositor, proc scan or time accrual.`

function options(args) {
  const config = {
    state: resolve(join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'focus-tracker', 'session.json')),
    html: null, titles: false, foot: false, help: false,
  }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--help' || flag === '-h') { config.help = true; continue }
    if (flag === '--titles' || flag === '--foot') { config[flag.slice(2)] = true; continue }
    if (flag !== '--state' && flag !== '--html') throw new Error('Unknown option. Use --help for supported export flags.')
    const value = args[++i]
    if (!value || value.startsWith('-')) throw new Error(`Missing path for ${flag}.`)
    config[flag.slice(2)] = resolve(value)
  }
  if (!config.help && !config.html) throw new Error('--html NEWFILE is required; no report was written.')
  if (config.html === config.state || config.html === `${config.state}.lock`) throw new Error('HTML output must differ from the checkpoint and its lock path.')
  return config
}

function checkOutputPaths(state, html) {
  const conflicts = (input, output) => output === input || output === `${input}.lock`
  if (conflicts(state, html)) throw new Error('HTML output must differ from the checkpoint and its lock path.')
  try {
    // Resolve directory aliases, but never follow a final-component output symlink.
    const input = join(realpathSync(dirname(state)), basename(state))
    const output = join(realpathSync(dirname(html)), basename(html))
    if (conflicts(input, output)) throw new Error('HTML output must differ from the checkpoint and its lock path.')
  } catch (error) {
    if (!error.code) throw error
    throw new Error('Checkpoint and HTML parent directories must already exist and be accessible; no directories were created.')
  }
}

function main(args = process.argv.slice(2)) {
  const config = options(args)
  if (config.help) { console.log(HELP); return }
  // Read first so a missing input has a checkpoint-specific error. No output
  // creation occurs until every input/policy/path check has succeeded.
  const report = readCheckpoint(config.state, config.titles, config.foot)
  checkOutputPaths(config.state, config.html)
  try { writeHtml(config.html, report) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('HTML output already exists or is a symlink; choose a new --html filename.')
    throw new Error('Could not create HTML output; existing files are never overwritten. Check the destination permissions and free space.')
  }
  console.error('HTML report saved privately from the latest saved snapshot (typically 5 seconds behind; not a live query).')
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}

module.exports = { main, options }
