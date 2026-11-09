'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { renderHtml } = require('./html-report.cjs')

const report = {
  elapsedMs: 10000, trackedMs: 8000, excluded: [],
  apps: [['foot', 6000], ['Browser', 2000]], titlesEnabled: true, footEnabled: true,
  details: [{ app: 'Browser', title: 'Documentation', ms: 2000 }],
  terminals: [{ app: 'foot', executable: 'claude', ms: 4000 }, { app: 'foot', executable: null, reason: 'ambiguous', ms: 2000 }],
  agentLabels: [{ app: 'foot', executable: 'claude', label: 'Theme exploration', ms: 3000 }],
}

test('tree nests correlated labels and keeps titles a separate breakdown', () => {
  const html = renderHtml(report)
  assert.equal([...html.matchAll(/data-app open/g)].length, 2)
  assert.match(html, /Observed agent labels/)
  assert.match(html, /Theme exploration/)
  assert.match(html, /Unknown — ambiguous/)
  assert.match(html, /Observed window titles · separate breakdown/)
  assert.match(html, /separate, overlapping breakdowns/)
  assert.match(html, /Agent labels cover correlated observations only/)
})

test('tree respects collection opt-ins even when detail fields are supplied', () => {
  const html = renderHtml({ ...report, footEnabled: false, titlesEnabled: false })
  assert.doesNotMatch(html, /Documentation|Theme exploration|Unknown — ambiguous/)
  assert.match(html, /No detail observations recorded/)
})

let chromium
try { ({ chromium } = require('playwright')) } catch { /* Optional browser tooling. */ }
test('offline report controls work under CSP, on mobile and without scripts', { skip: !chromium && 'Optional browser check requires Playwright and Chromium' }, async () => {
  const http = require('node:http')
  const html = renderHtml({ ...report, details: [...report.details, { app: 'Browser', title: '</script><script>window.injected=true</script>', ms: 0 }] })
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = [], requests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('request', request => requests.push(request.url()))
    const url = `http://127.0.0.1:${server.address().port}/`
    await page.goto(url)
    assert.equal(await page.evaluate(() => window.injected), undefined)
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
    assert.equal(await page.locator('.app-tree details[open]').count(), 0)
    await page.locator('#entry-search').fill('exploration')
    assert.equal(await page.locator('[data-app]:visible').count(), 1)
    assert.match(await page.locator('[data-entry]:visible').innerText(), /Theme exploration/)
    await page.locator('#entry-search').fill('no match here')
    assert.ok(await page.locator('#no-matches').isVisible())
    await page.locator('#entry-search').fill('')
    assert.equal(await page.locator('.app-tree details[open]').count(), 0)
    await page.getByRole('button', { name: 'Expand all', exact: true }).click()
    assert.equal(await page.locator('.app-tree details:not([open])').count(), 0)
    await page.locator('#entry-search').fill('claude')
    assert.match((await page.locator('[data-entry]:visible').allTextContents()).join(' '), /Theme exploration/)
    await page.locator('#entry-search').fill('')
    await page.getByRole('button', { name: 'Dark theme', exact: true }).click()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    await page.locator('[data-app]>summary').first().focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('[data-app]').first().getAttribute('open'), null)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    const tooltip = page.locator('#credit-tooltip');
    const credit = page.getByRole('button', { name: 'Icon attribution details', exact: true });
    assert.equal(await tooltip.isVisible(), false);
    await page.locator('.credit-info').hover();
    assert.ok(await tooltip.isVisible());
    await credit.focus();
    await page.keyboard.press('Escape');
    assert.equal(await tooltip.isVisible(), false);
    await credit.click();
    assert.equal(await credit.getAttribute('aria-expanded'), 'true');
    assert.ok(await tooltip.isVisible());
    const tipBox = await tooltip.boundingBox();
    assert.ok(tipBox.x >= 0 && tipBox.x + tipBox.width <= 390);
    await credit.click();
    assert.equal(await tooltip.isVisible(), false);
    await page.locator('#entry-search').focus();
    await credit.focus();
    assert.ok(await tooltip.isVisible());
    await page.locator('#entry-search').focus();
    await page.mouse.move(0, 0);
    assert.equal(await tooltip.isVisible(), false);
    assert.equal(await page.locator('.icon-credit a').count(), 2);
    assert.equal(await page.locator('.icon-credit a').nth(0).getAttribute('href'), 'https://selfh.st/icons/');
    assert.equal(await page.locator('.icon-credit a').nth(1).getAttribute('href'), 'https://creativecommons.org/licenses/by/4.0/');
    assert.deepEqual(errors, [])
    assert.deepEqual(requests, [url])
    const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(url);
    const touchCredit = touchPage.getByRole('button', { name: 'Icon attribution details', exact: true });
    await touchCredit.tap();
    assert.ok(await touchPage.locator('#credit-tooltip').isVisible());
    await touchCredit.tap();
    assert.equal(await touchPage.locator('#credit-tooltip').isVisible(), false);
    await touchContext.close();
    const context = await browser.newContext({ javaScriptEnabled: false })
    const fallback = await context.newPage()
    await fallback.goto(url)
    assert.ok(await fallback.locator('[data-entry]').filter({ hasText: 'Documentation' }).isVisible())
    assert.equal(await fallback.locator('.tree-tools').isVisible(), false)
    await fallback.locator('[data-app]>summary').first().click()
    assert.equal(await fallback.locator('[data-app]').first().getAttribute('open'), null)
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})


test('process icons use reviewed assets and safe fallbacks, leaving labels text-only', () => {
  const { processIcon } = require('./process-icons.cjs')
  assert.match(processIcon('claude'), /#d97757/)
  assert.match(processIcon('librewolf'), /#00acff/)
  assert.match(processIcon('pi'), /process-pi/)
  for (const name of ['nvim', 'foot', 'unknown', '__proto__', '</svg><script>bad</script>']) {
    assert.match(processIcon(name), /aria-hidden="true"/)
    assert.doesNotMatch(processIcon(name), /<script|http:|undefined|\[object Object\]/)
  }
  const html = renderHtml(report)
  assert.equal([...html.matchAll(/class="process-icon"/g)].length, 4)
  assert.doesNotMatch(html, /process-icon[^<]*Documentation/)
})
