#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { join, resolve } = require('node:path')
const { TimelineStore, project, defaultDirectory } = require('./timeline-store.cjs')
const { processIcon } = require('./process-icons.cjs')
// A fixed asset catalog shared with the offline report. Labels never select files.
const processIcons = Object.fromEntries(['claude', 'librewolf', 'foot', 'foot-client', 'nvim', 'neovim', 'pi', 'default'].map(name => [name, processIcon(name)]))

async function startServer({ directory = defaultDirectory(), port = 4318 } = {}) {
  const store = new TimelineStore(directory)
  const socketPath = join(directory, 'collector.sock')
  let ipc, web
  let socketCreated = false
  try {
    // The journal lock is held before removing a leftover socket from a crash.
    try {
      const stat = fs.lstatSync(socketPath)
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Refusing to replace non-owned collector socket')
      fs.unlinkSync(socketPath)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    ipc = net.createServer(socket => {
      let body = '', used = false
      socket.setTimeout(2000, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('data', chunk => {
        if (used) return
        body += chunk
        if (Buffer.byteLength(body) > 16384) { used = true; socket.end('{"ok":false,"error":"Event too large"}\n'); return }
        if (!body.includes('\n')) return
        used = true
        try {
          store.accept(JSON.parse(body.trim()))
          socket.end('{"ok":true}\n')
        } catch { socket.end('{"ok":false,"error":"Invalid event or journal unavailable"}\n') }
      })
    })
    await listen(ipc, socketPath)
    socketCreated = true
    fs.chmodSync(socketPath, 0o600)
    const assets = new Map([
      ['/', ['index.html', 'text/html; charset=utf-8']],
      ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
      ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ])
    web = http.createServer((req, res) => {
      const host = `127.0.0.1:${web.address().port}`
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
      res.setHeader('Referrer-Policy', 'no-referrer')
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
        res.writeHead(403).end('Local same-origin access only'); return
      }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return }
      let url
      try { url = new URL(req.url, `http://${host}`) }
      catch { res.writeHead(400).end('Invalid URL'); return }
      if (url.pathname === '/api/process-icons') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(processIcons))
        return
      }
      if (url.pathname === '/api/timeline') {
        if (store.failed) { res.writeHead(503).end('Journal unavailable; restart the collector after fixing storage'); return }
        const now = Date.now()
        const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : now - 86400000
        const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : now
        const agent = url.searchParams.get('agent') || ''
        const status = url.searchParams.get('status') || ''
        const includeAgents = url.searchParams.get('includeAgents') || ''
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 31 * 86400000 ||
            !['', 'human', 'agents', 'claude', 'pi', 'kiro-cli'].includes(agent) ||
            !['', 'agents', 'claude', 'pi', 'kiro-cli'].includes(includeAgents) ||
            !['', 'working', 'waiting', 'stopped', 'tracking', 'paused', 'idle', 'locked', 'no focus', 'IPC unavailable', 'activity-unavailable', 'unknown'].includes(status)) {
          res.writeHead(400).end('Invalid range or filter (maximum 31 days)'); return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(project(store.events, now, { from, to, agent, status, includeAgents })))
        return
      }
      const asset = assets.get(url.pathname)
      if (!asset) { res.writeHead(404).end('Not found'); return }
      res.writeHead(200, { 'Content-Type': asset[1] }).end(fs.readFileSync(join(__dirname, 'timeline-web', asset[0])))
    })
    web.requestTimeout = 5000
    await listen(web, port, '127.0.0.1')
    return {
      store, socketPath, port: web.address().port,
      async close() {
        await Promise.all([new Promise(r => { web.close(r); web.closeAllConnections() }), new Promise(r => ipc.close(r))])
        store.close()
      },
    }
  } catch (error) {
    web?.close(); ipc?.close()
    if (socketCreated) { try { fs.unlinkSync(socketPath) } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup } }
    store.close()
    throw error
  }
}
function listen(server, ...args) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(...args, () => { server.removeListener('error', reject); resolve() }) })
}

if (require.main === module) {
  const args = process.argv.slice(2), config = {}
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--help') { console.log('Usage: node poc/timeline-server.cjs [--directory PATH] [--port 4318]\nLocal read-only timeline UI; events arrive through its private Unix socket.'); process.exit(0) }
      if (!['--directory', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid option; use --help')
      const flag = args[i++], value = args[i]
      if (flag === '--directory') config.directory = resolve(value)
      else { config.port = Number(value); if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port') }
    }
    startServer(config).then(server => {
      console.log(`Timeline listening on 127.0.0.1:${server.port}; private socket: ${server.socketPath}`)
      let closing = false
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (!closing) { closing = true; server.close().catch(error => { console.error(error.message); process.exitCode = 1 }) } })
    }).catch(error => { console.error(error.message); process.exitCode = 1 })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { startServer }
