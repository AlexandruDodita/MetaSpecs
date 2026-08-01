import { chromium } from 'playwright'

const URL = 'http://localhost:5173'
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForSelector('.react-flow__pane')

const pane = page.locator('.react-flow__pane')
const activeToolTitle = () =>
  page.locator('.toolbar__btn--active').first().getAttribute('title')

// Start from a clean layer so counts are deterministic.
page.on('dialog', (d) => d.accept())
await page.locator('.toolbar__btn--danger').last().click()
await page.waitForTimeout(200)

// ---- Bug 1: modifier keys must not hijack tool hotkeys ----
await pane.click({ position: { x: 500, y: 400 } })
await page.keyboard.press('Control+c')
await page.waitForTimeout(100)
check('Ctrl+C does not arm circle tool', (await activeToolTitle())?.includes('Select'), `active=${await activeToolTitle()}`)
await page.keyboard.press('Control+t')
await page.waitForTimeout(100)
check('Ctrl+T does not arm table tool', (await activeToolTitle())?.includes('Select'), `active=${await activeToolTitle()}`)

// Bare hotkey must still work.
await page.keyboard.press('r')
await page.waitForTimeout(100)
check('bare "r" still arms rect tool', (await activeToolTitle())?.includes('rectangle'), `active=${await activeToolTitle()}`)
await page.keyboard.press('v')
await page.waitForTimeout(100)

// ---- Add three tables via the pane context menu ----
const addTableAt = async (x, y) => {
  await pane.click({ button: 'right', position: { x, y } })
  await page.locator('.menu__item', { hasText: 'Add table' }).first().click()
  await page.waitForTimeout(150)
}
await addTableAt(300, 250)
await addTableAt(650, 250)
await addTableAt(1000, 250)
let ids = await page.locator('.react-flow__node').evaluateAll((ns) => ns.map((n) => n.dataset.id))
check('3 tables created', ids.length === 3, `count=${ids.length}`)

// ---- Bug 2: batch duplicate must produce unique ids ----
// Rubber-band select: RF needs Shift here because panOnDrag and selectionOnDrag
// are both enabled for the select tool.
await page.keyboard.down('Shift')
await page.mouse.move(150, 150)
await page.mouse.down()
await page.mouse.move(1390, 700, { steps: 12 })
await page.mouse.up()
await page.keyboard.up('Shift')
await page.waitForTimeout(250)
const selectedCount = await page.locator('.react-flow__node.selected').count()
check('shift-drag selects all 3 nodes', selectedCount === 3, `selected=${selectedCount}`)
await page.locator('.toolbar__btn[title="Duplicate selected node"]').click()
await page.waitForTimeout(300)
ids = await page.locator('.react-flow__node').evaluateAll((ns) => ns.map((n) => n.dataset.id))
const unique = new Set(ids)
check('batch duplicate yields unique node ids', unique.size === ids.length, `${ids.length} nodes, ${unique.size} unique`)

// ---- Bug 3: Escape exits edit mode from inside a form field ----
// Reset to a clean layer first: the batch-duplicate step above leaves
// duplicate nodes stacked ~40px on top of their originals (duplicateNode
// offsets by {x:+40,y:+40}), and being later in DOM order they paint on
// top and intercept pointer events meant for the original node underneath.
await page.locator('.toolbar__btn--danger').last().click()
await page.waitForTimeout(200)
await addTableAt(600, 400)
const firstNode = page.locator('.react-flow__node').first()
await firstNode.dblclick()
await page.waitForSelector('.table-edit', { timeout: 3000 })
check('double-click opens edit form', true)
const nameInput = page.locator('.table-edit__name').first()
await nameInput.click()
await nameInput.fill('zzz_should_revert')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const stillEditing = await page.locator('.table-edit').count()
check('Escape closes edit form while focus is in a field', stillEditing === 0, `forms open=${stillEditing}`)
const revertedLabel = await page.locator('.schema__name').first().innerText()
check('Escape reverts the edited label', revertedLabel !== 'zzz_should_revert', `label="${revertedLabel}"`)

check('no uncaught page errors', errors.length === 0, errors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
