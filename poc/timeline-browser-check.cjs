const { chromium } = require('playwright')
const { startServer } = require('./timeline-server.cjs')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const assert = require('node:assert/strict')
// Optional development-only check: requires Playwright and an installed Chromium.
async function main() {
 const directory=mkdtempSync(join(tmpdir(),'focus-browser-')), server=await startServer({directory,port:0})
 let browser
 try {
  const now=Date.now(), start=now-3600000
  const agent=(at,name,session,status)=>({type:'agent',at,agent:name,session,status,id:`${session}-${at}`})
  server.store.events.push(
   {type:'human',session:'human-demo',id:'h1',status:'tracking',app:'Editor <img src=x onerror=alert(1)>',title:'PRIVATE_DEMO_TITLE',start,end:start+1800000},
   {type:'human',session:'human-demo',id:'h2',status:'idle',start:start+1800000,end:now},
   agent(start,'claude','claude-demo','working'),agent(start+10000,'pi','pi-demo','working'))
  // Simulate uninterrupted heartbeat evidence over the full task.
  for(let at=start+20000;at<now;at+=20000) {
   server.store.events.push(agent(at,'claude','claude-demo','heartbeat'),agent(at,'pi','pi-demo','heartbeat'))
  }
  server.store.events.push(agent(now,'claude','claude-demo','waiting'),agent(now,'pi','pi-demo','stopped'))
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']})
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.port}`)
  await page.waitForSelector('.span')
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)')
  await page.locator('#theme-toggle').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), 'true')
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(23, 23, 23)')
  assert.equal(await page.locator('#theme-toggle').innerText(), 'Light theme')
  assert.equal(await page.locator('.lane').count(),3)
  const humanLane = page.locator('.lane').filter({ has: page.locator('.lane-label', { hasText: 'You' }) })
  const focusBar = await humanLane.locator('.span[data-status="tracking"]').boundingBox()
  const idleBar = await humanLane.locator('.span[data-status="idle"]').boundingBox()
  assert.ok(focusBar.height <= 14, 'interval bars should be slim')
  assert.ok(idleBar.y > focusBar.y + focusBar.height, 'excluded activity must occupy a different Y track')
  assert.equal(await humanLane.locator('.subtrack-label').count(), 2)
  assert.equal(await page.locator('img').count(),0)
  await page.locator('.span[data-status="tracking"]').click()
  assert.match(await page.locator('#inspector').innerText(),/PRIVATE_DEMO_TITLE/)
  await page.screenshot({path:'/tmp/time-tracker-timeline.png',fullPage:true})
  await page.selectOption('#agent','claude')
  await page.waitForFunction(()=>document.querySelectorAll('.lane').length===1)
  assert.match(await page.locator('.lane-label').innerText(),/claude/)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  await page.selectOption('#agent','')
  await page.selectOption('#status','tracking')
  await page.waitForFunction(()=>document.querySelectorAll('.lane').length===1&&document.querySelector('.lane-label').textContent.includes('You'))
  await page.selectOption('#status','')
  await page.click('#zoom-in')
  await page.waitForTimeout(100)
  await page.click('#previous')
  await page.waitForFunction(()=>document.querySelector('#empty').hidden===false)
  assert.equal(await page.locator('#live').isChecked(),false)
  await page.check('#live')
  await page.waitForSelector('.span')
  const downloadPromise=page.waitForEvent('download')
  await page.click('#export')
  const download=await downloadPromise
  assert.equal(download.suggestedFilename(),'focus-timeline.json')
  await page.setViewportSize({width:390,height:844})
  await page.click('#theme-toggle')
  assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), 'false')
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)')
  await page.screenshot({path:'/tmp/time-tracker-timeline-mobile.png',fullPage:true})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false)
  assert.deepEqual(errors,[])
  console.log('PASS browser: slim activity subtracks with distinct Y positions, light/dark theme, keyboard toggle, theme retained through refresh, parallel lanes, safe text rendering, span details, filters, zoom, navigation, live mode, JSON download, mobile layout, no JS errors')
 } finally { await browser?.close();await server.close();rmSync(directory,{recursive:true,force:true}) }
}
main().catch(e=>{console.error(e);process.exitCode=1})
