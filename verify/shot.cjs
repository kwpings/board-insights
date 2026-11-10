/**
 * Screenshot a rendered verify/*.html page with the installed Chrome, and prove the page
 * does not scroll sideways at the requested width.
 *
 *   NODE_PATH=<hermes-agent>/node_modules node verify/shot_dashboard.cjs \
 *       verify/dashboard-7.html verify/dashboard-7.png 1410 950
 *
 * Prints the measured page metrics (grid columns, scrollWidth vs clientWidth, panel order).
 * Exits 1 if the page overflows horizontally. playwright-core is the app's own copy
 * (hermes-agent/node_modules), so nothing is installed or downloaded.
 */

const path = require('node:path')

const { chromium } = require('playwright-core')

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

async function main() {
  const [file, out, width = '1410', height = '950'] = process.argv.slice(2)
  if (!file || !out) {
    console.error('usage: node shot_dashboard.cjs <input.html> <out.png> [width] [height]')
    process.exit(2)
  }

  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome' })
  } catch {
    browser = await chromium.launch({ executablePath: CHROME })
  }

  const page = await browser.newPage({
    viewport: { width: Number(width), height: Number(height) },
    deviceScaleFactor: 1
  })
  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/')
  await page.goto(url, { waitUntil: 'load' })

  const metrics = await page.evaluate(() => {
    const root = document.documentElement
    const grid = document.querySelector('.grid')
    const headings = [...document.querySelectorAll('.card .stitle')].map(node => {
      const clone = node.cloneNode(true)
      clone.querySelectorAll('.shint').forEach(hint => hint.remove())
      return clone.textContent.trim()
    })
    const tiles = [...document.querySelectorAll('.tile .tlabel')].map(node => node.textContent.trim())

    const overflowing = [...document.querySelectorAll('.card, .card *')]
      .filter(node => node.scrollWidth > node.clientWidth + 1)
      .map(node => (node.className || node.tagName) + ' ' + node.scrollWidth + '>' + node.clientWidth)

    const cardRects = [...document.querySelectorAll('.card')].map(node => {
      const heading = node.querySelector('.stitle')
      const clone = heading ? heading.cloneNode(true) : null
      if (clone) clone.querySelectorAll('.shint').forEach(hint => hint.remove())
      const rect = node.getBoundingClientRect()
      return {
        panel: clone ? clone.textContent.trim() : '(card)',
        x: Math.round(rect.x),
        y: Math.round(rect.y + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    })

    return {
      viewportWidth: window.innerWidth,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      pageHeight: root.scrollHeight,
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      panelOrder: headings,
      cardRects,
      tiles,
      fullWidthPanels: [...document.querySelectorAll('.card.span3 .stitle')].map(node => node.textContent.trim()),
      overflowingElements: overflowing.slice(0, 10),
      overflowingCount: overflowing.length
    }
  })

  await page.screenshot({ path: out, fullPage: true })
  await browser.close()

  console.log(JSON.stringify({ file: path.basename(file), out: path.basename(out), ...metrics }, null, 2))

  if (metrics.scrollWidth > metrics.clientWidth || metrics.bodyScrollWidth > metrics.clientWidth) {
    console.error('HORIZONTAL OVERFLOW: page is wider than its viewport')
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
