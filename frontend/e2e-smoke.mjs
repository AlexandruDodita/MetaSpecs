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

// Create a dedicated smoke-test project and clear every layer via the API
// before the app ever mounts. If a prior run's leftover nodes are still on
// disk, the very first render triggers an auto-fitView zoom (see
// GraphCanvas's fittedKeyRef effect) before this script gets a chance to
// clear anything through the UI — that skews the viewport transform and
// makes every later pixel-coordinate drag/selection in this script
// non-deterministic across repeated runs. Clearing server state first keeps
// every layer's initial viewport at the identity transform, matching what a
// truly fresh backend would give us.
const createResp = await page.request.post('http://localhost:8000/api/projects', {
  data: { name: 'Smoke Test' },
})
const projectId = (await createResp.json()).id
const createdProjectIds = [projectId]
const graphUrl = (layer) => `http://localhost:8000/api/projects/${projectId}/graph/${layer}`
for (const layer of ['backend', 'db', 'frontend']) {
  await page.request.post(graphUrl(layer), { data: { nodes: [], edges: [] } })
}

// First launch has no remembered project, so the app boots into the picker.
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForSelector('.project-picker')
check('first open shows the project picker', (await page.locator('.project-picker').count()) === 1)
const pickerRowName = await page
  .locator('.project-picker__row .project-picker__open strong')
  .first()
  .innerText()
  .catch(() => '')
check('picker lists the created project', pickerRowName === 'Smoke Test', `name="${pickerRowName}"`)
await page
  .locator('.project-picker__row .project-picker__open', { hasText: 'Smoke Test' })
  .first()
  .click()
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
// Reset to a clean layer first: the batch-duplicate step above leaves three
// extra tables offset to the right (duplicateNode shifts x by width + 24), and
// being later in DOM order they intercept clicks meant for what they overlap.
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

// ==== New checks for this batch ====

const clickTab = async (label) => {
  await page.locator('.tab', { hasText: label }).click()
  await page.waitForTimeout(150)
}
const clearActiveLayer = async () => {
  await page.locator('.toolbar__btn--danger').last().click()
  await page.waitForTimeout(200)
}
// The header "Save all" button was removed in favour of an always-visible
// `.save-status` readout ("Saving…" / "Unsaved changes" / "Saved" / "Save
// failed"). Every check that used to assert on the button's enabled/disabled
// state now reads this text instead.
const readSaveStatus = async () => page.locator('.save-status').innerText().catch(() => '')

// ---- 1: autosave persists to the backend without clicking Save ----
await clickTab('Database')
await clearActiveLayer()
await addTableAt(500, 400)
await page.waitForTimeout(1500)
const saveStatusText = await page.locator('.save-status').innerText().catch(() => '')
check('autosave: header shows "Saved"', saveStatusText === 'Saved', `text="${saveStatusText}"`)
const dbResp = await page.request.get(graphUrl('db'))
const dbJson = await dbResp.json()
check('autosave: server has 1 node for db layer', dbJson.nodes?.length === 1, `nodes=${dbJson.nodes?.length}`)

// ---- 2: dirty indicator clears once autosave has landed ----
const activeTabDots = await page.locator('.tab--active .tab__dot').count()
check('dirty dot clears on active tab after autosave', activeTabDots === 0, `dots=${activeTabDots}`)
const statusAfterAutosave = await readSaveStatus()
check('after autosave, nothing left to save: status reads "Saved"', statusAfterAutosave === 'Saved', `text="${statusAfterAutosave}"`)

// ---- 3: dragging a node snaps its final position to the 10px grid ----
const dragNode = page.locator('.react-flow__node').first()
const box = await dragNode.boundingBox()
const startX = box.x + box.width / 2
const startY = box.y + box.height / 2
await page.mouse.move(startX, startY)
await page.mouse.down()
await page.mouse.move(startX + 37, startY + 23, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(1500)
const dbResp2 = await page.request.get(graphUrl('db'))
const dbJson2 = await dbResp2.json()
const draggedPos = dbJson2.nodes?.[0]?.position
check(
  'dragged node position snaps to 10px grid',
  !!draggedPos && draggedPos.x % 10 === 0 && draggedPos.y % 10 === 0,
  `position=${JSON.stringify(draggedPos)}`,
)

// ---- 4a: Shift+drag rubber-band box-selects on the select tool ----
// Panning was reverted to plain left-drag; box-select now requires Shift.
await clearActiveLayer()
await addTableAt(300, 250)
await addTableAt(650, 250)
await page.keyboard.down('Shift')
await page.mouse.move(150, 150)
await page.mouse.down()
await page.mouse.move(1390, 700, { steps: 12 })
await page.mouse.up()
await page.keyboard.up('Shift')
await page.waitForTimeout(250)
const shiftDragSelected = await page.locator('.react-flow__node.selected').count()
check('Shift+drag box-selects both nodes', shiftDragSelected === 2, `selected=${shiftDragSelected}`)

// ---- 4b: plain left-drag (no Shift) pans the viewport instead of selecting ----
// 4a left both nodes selected; clear that first so this check starts from
// "nothing selected" as specified. (750, 600) is clear of both nodes
// (which span roughly x:300-910, y:250-400), the left toolbar, the
// right-hand side panel (x>=1060), and the bottom-docked minimap/controls.
await pane.click({ position: { x: 750, y: 600 } })
await page.waitForTimeout(150)
const viewportTransformBefore = await page.locator('.react-flow__viewport').evaluate((el) => el.style.transform)
await page.mouse.move(150, 150)
await page.mouse.down()
await page.mouse.move(1390, 700, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(250)
const viewportTransformAfter = await page.locator('.react-flow__viewport').evaluate((el) => el.style.transform)
const panSelectedCount = await page.locator('.react-flow__node.selected').count()
check(
  'plain left-drag pans instead of selecting',
  viewportTransformAfter !== viewportTransformBefore && panSelectedCount === 0,
  `before="${viewportTransformBefore}" after="${viewportTransformAfter}" selected=${panSelectedCount}`,
)

// ---- 5: duplicate places the copy beside the original, no overlap ----
await clearActiveLayer()
await addTableAt(400, 300)
await page.locator('.react-flow__node').first().click()
await page.waitForTimeout(150)
await page.locator('.toolbar__btn[title="Duplicate selected node"]').click()
await page.waitForTimeout(300)
const dupNodes = page.locator('.react-flow__node')
const dupCount = await dupNodes.count()
let dupOverlap = true
if (dupCount === 2) {
  const b0 = await dupNodes.nth(0).boundingBox()
  const b1 = await dupNodes.nth(1).boundingBox()
  dupOverlap = b0.x < b1.x + b1.width && b1.x < b0.x + b0.width
}
check('duplicate creates 2 nodes', dupCount === 2, `count=${dupCount}`)
check('duplicated node does not overlap the original', !dupOverlap, `overlap=${dupOverlap}`)

// ---- 6: adding a node to an already-loaded, now-empty layer must not yank the viewport ----
await clickTab('Frontend')
await clearActiveLayer()
const viewportBefore = await page.locator('.react-flow__viewport').getAttribute('style')
await addTableAt(500, 400)
await page.waitForTimeout(1500)
const viewportAfter = await page.locator('.react-flow__viewport').getAttribute('style')
check(
  'no viewport auto-fit/jump after adding the first node',
  viewportBefore === viewportAfter,
  `before="${viewportBefore}" after="${viewportAfter}"`,
)

// ==== Undo/redo checks ====

// ---- 1 & 2: undo/redo of adding a node ----
await clickTab('Database')
await clearActiveLayer()
await addTableAt(500, 400)
await page.waitForTimeout(300)
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
let undoAddCount = await page.locator('.react-flow__node').count()
check('undo add: single Ctrl+Z removes the added node', undoAddCount === 0, `count=${undoAddCount}`)

await page.keyboard.press('Control+Shift+z')
await page.waitForTimeout(300)
let redoAddCount = await page.locator('.react-flow__node').count()
check('redo add: single Ctrl+Shift+Z restores the node', redoAddCount === 1, `count=${redoAddCount}`)

// ---- 3: one undo of a whole drag returns to the pre-drag position, not mid-path ----
await clearActiveLayer()
await addTableAt(500, 400)
await page.waitForTimeout(300)
const dragTarget = page.locator('.react-flow__node').first()
const preDragBox = await dragTarget.boundingBox()
const cx = preDragBox.x + preDragBox.width / 2
const cy = preDragBox.y + preDragBox.height / 2
await page.mouse.move(cx, cy)
await page.mouse.down()
await page.mouse.move(cx + 90, cy + 55, { steps: 6 })
await page.mouse.move(cx + 170, cy + 105, { steps: 6 })
await page.mouse.move(cx + 250, cy + 150, { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(400)
const postDragBox = await dragTarget.boundingBox()
const movedFar =
  Math.abs(postDragBox.x - preDragBox.x) > 100 && Math.abs(postDragBox.y - preDragBox.y) > 60
check(
  'drag: node actually moved a long distance before undo',
  movedFar,
  `dx=${(postDragBox.x - preDragBox.x).toFixed(1)} dy=${(postDragBox.y - preDragBox.y).toFixed(1)}`,
)
await page.keyboard.press('Control+z')
await page.waitForTimeout(400)
const undoDragBox = await dragTarget.boundingBox()
const tol = 4
const restoredExactly =
  Math.abs(undoDragBox.x - preDragBox.x) <= tol && Math.abs(undoDragBox.y - preDragBox.y) <= tol
check(
  'drag: a single Ctrl+Z restores the exact pre-drag position (not a point along the path)',
  restoredExactly,
  `pre=(${preDragBox.x.toFixed(1)},${preDragBox.y.toFixed(1)}) after-undo=(${undoDragBox.x.toFixed(1)},${undoDragBox.y.toFixed(1)})`,
)

// ---- 4: one undo reverts a whole rename edit session, not per keystroke ----
await clearActiveLayer()
await addTableAt(500, 400)
await page.waitForTimeout(200)
const renameNode = page.locator('.react-flow__node').first()
const prevName = await page.locator('.schema__name').first().innerText()
await renameNode.dblclick()
await page.waitForSelector('.table-edit')
const renameInput = page.locator('.table-edit__name').first()
await renameInput.click()
await renameInput.fill('')
await renameInput.type('renamed_long_table')
await page.locator('.table-edit__actions button', { hasText: 'Save' }).click()
await page.waitForTimeout(200)
const savedName = await page.locator('.schema__name').first().innerText()
check('rename: Save commits the new name', savedName === 'renamed_long_table', `name="${savedName}"`)
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
const afterUndoName = await page.locator('.schema__name').first().innerText()
check(
  'rename: a single Ctrl+Z reverts the whole edit session in one step',
  afterUndoName === prevName,
  `after-undo="${afterUndoName}" expected="${prevName}"`,
)

// ---- 5: deleting a connected node with the Delete key — is it one undo or two? ----
await clearActiveLayer()
await addTableAt(400, 300)
await addTableAt(800, 300)
await page.waitForTimeout(200)
await page.keyboard.press('w')
await page.waitForTimeout(100)
await page.locator('.react-flow__node').nth(0).click()
await page.waitForTimeout(100)
await page.locator('.react-flow__node').nth(1).click()
await page.waitForTimeout(200)
const wiredEdgeCount = await page.locator('.react-flow__edge').count()
check('wire tool: connecting two nodes creates 1 edge', wiredEdgeCount === 1, `edges=${wiredEdgeCount}`)
await page.keyboard.press('v')
await page.waitForTimeout(100)
await page.locator('.react-flow__node').nth(0).click()
await page.waitForTimeout(150)
await page.keyboard.press('Delete')
await page.waitForTimeout(300)
const afterDelNodes = await page.locator('.react-flow__node').count()
const afterDelEdges = await page.locator('.react-flow__edge').count()
check(
  'delete: keyboard Delete removes the selected node and its connected edge',
  afterDelNodes === 1 && afterDelEdges === 0,
  `nodes=${afterDelNodes} edges=${afterDelEdges}`,
)
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
const afterOneUndoNodes = await page.locator('.react-flow__node').count()
const afterOneUndoEdges = await page.locator('.react-flow__edge').count()
const fullyRestoredByOne = afterOneUndoNodes === 2 && afterOneUndoEdges === 1
check(
  'delete-undo: a single Ctrl+Z fully restores both the node and the edge',
  fullyRestoredByOne,
  `after 1x Ctrl+Z: nodes=${afterOneUndoNodes} edges=${afterOneUndoEdges}`,
)
if (!fullyRestoredByOne) {
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  const afterTwoUndoNodes = await page.locator('.react-flow__node').count()
  const afterTwoUndoEdges = await page.locator('.react-flow__edge').count()
  console.log(
    `    [diagnostic] after a 2nd Ctrl+Z: nodes=${afterTwoUndoNodes} edges=${afterTwoUndoEdges}` +
      ` — full restore needed ${afterTwoUndoNodes === 2 && afterTwoUndoEdges === 1 ? '2' : 'more than 2'} Ctrl+Z presses`,
  )
}

// ---- 6: undo restores a whole cleared graph in one step ----
await clearActiveLayer()
await addTableAt(400, 300)
await addTableAt(800, 300)
await page.waitForTimeout(200)
await page.locator('.toolbar__btn--danger').last().click()
await page.waitForTimeout(250)
const afterClearCount = await page.locator('.react-flow__node').count()
check('clear graph: toolbar "Clear this graph" empties the layer', afterClearCount === 0, `count=${afterClearCount}`)
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
const afterClearUndoCount = await page.locator('.react-flow__node').count()
check('clear graph: a single Ctrl+Z restores both nodes', afterClearUndoCount === 2, `count=${afterClearUndoCount}`)

// ---- 7: toolbar Undo/Redo enabled state tracks real history ----
// Force a truly empty history by clearing every layer directly on the
// server and reloading — loadAll() resets past/future to [] for every
// layer, which a UI-driven "Clear this graph" click would not (clearLayer
// itself pushes a history entry). Clearing ALL layers (not just db) here
// matters: the other layers still hold nodes left over from earlier
// checks, and GraphCanvas auto-fitView's on any layer that has nodes right
// after a reload (see fittedKeyRef in GraphCanvas.tsx) — if the default
// "backend" layer still had nodes, that auto-fit would skew the shared
// viewport transform before we ever switch to Database, breaking every
// later pixel-coordinate right-click in this script (same hazard the
// top-of-file pre-clear comment describes).
for (const layer of ['backend', 'db', 'frontend']) {
  await page.request.post(graphUrl(layer), { data: { nodes: [], edges: [] } })
}
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('.react-flow__pane')
await clickTab('Database')
await page.waitForTimeout(300)
const undoBtn = () => page.locator('.toolbar__btn[title="Undo (Ctrl+Z)"]')
const redoBtn = () => page.locator('.toolbar__btn[title="Redo (Ctrl+Shift+Z)"]')
const undoDisabledFresh = await undoBtn().isDisabled()
check('toolbar: Undo is disabled on a freshly loaded layer with no history', undoDisabledFresh, `disabled=${undoDisabledFresh}`)
await addTableAt(500, 400)
await page.waitForTimeout(200)
const undoDisabledAfterAdd = await undoBtn().isDisabled()
const redoDisabledAfterAdd = await redoBtn().isDisabled()
check(
  'toolbar: after adding a node, Undo enables and Redo stays disabled',
  !undoDisabledAfterAdd && redoDisabledAfterAdd,
  `undoDisabled=${undoDisabledAfterAdd} redoDisabled=${redoDisabledAfterAdd}`,
)
await undoBtn().click()
await page.waitForTimeout(200)
const redoDisabledAfterUndo = await redoBtn().isDisabled()
check('toolbar: after pressing Undo, Redo becomes enabled', !redoDisabledAfterUndo, `redoDisabled=${redoDisabledAfterUndo}`)

// ---- 8: Ctrl+Z while focus is inside a text field must not undo the graph ----
await addTableAt(400, 300)
await addTableAt(800, 300)
await page.waitForTimeout(200)
const preFieldTestCount = await page.locator('.react-flow__node').count()
check('setup: 2 nodes exist before the in-field Ctrl+Z test', preFieldTestCount === 2, `count=${preFieldTestCount}`)
await page.locator('.react-flow__node').first().dblclick()
await page.waitForSelector('.table-edit')
const fieldInput = page.locator('.table-edit__name').first()
await fieldInput.click()
await fieldInput.type('xyz')
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
const afterFieldCtrlZCount = await page.locator('.react-flow__node').count()
check(
  'Ctrl+Z inside a text field does not undo the graph',
  afterFieldCtrlZCount === 2,
  `count=${afterFieldCtrlZCount}`,
)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// ---- 9 & 10: loading and clicking a node must not dirty the graph ----
await clearActiveLayer()
await addTableAt(500, 400)
await page.waitForTimeout(1500)
// Same auto-fitView hazard as above: clear the other two layers server-side
// (leaving db's freshly-autosaved single node alone) so the reload's
// default-active "backend" layer has nothing to fit-zoom to.
for (const layer of ['backend', 'frontend']) {
  await page.request.post(graphUrl(layer), { data: { nodes: [], edges: [] } })
}
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('.react-flow__pane')
await page.waitForTimeout(1500)
const statusAfterLoad = await readSaveStatus()
const tabDotCountAfterLoad = await page.locator('.tab__dot').count()
check('loading does not dirty the graph: status reads "Saved"', statusAfterLoad === 'Saved', `text="${statusAfterLoad}"`)
check('loading the app does not dirty the graph: no tab shows a dirty dot', tabDotCountAfterLoad === 0, `dots=${tabDotCountAfterLoad}`)

await clickTab('Database')
await page.locator('.react-flow__node').first().click()
await page.waitForTimeout(1200)
const statusAfterClick = await readSaveStatus()
check('clicking a node does not dirty it: status still reads "Saved"', statusAfterClick === 'Saved', `text="${statusAfterClick}"`)

// ---- 11: Backspace inside a text field must edit text, never delete the selected node ----
// Reset every layer server-side and reload before the remaining pixel-coordinate
// checks. Check 9/10 above deliberately reloads with 1 pre-existing node left in the
// Database layer to test that reload-with-data doesn't dirty the graph, then switches
// to the Database tab — which is that layer's first mount since the reload, so
// GraphCanvas's auto-fit-to-loaded-content runs and zooms the viewport in on that lone
// node (same hazard the comments above check 7 and the top-of-file pre-clear describe).
// Left as-is, that skewed transform makes every fixed screen-coordinate right-click
// below land in the wrong place. Clearing all layers and reloading restores the
// identity transform, same technique used before check 7.
for (const layer of ['backend', 'db', 'frontend']) {
  await page.request.post(graphUrl(layer), { data: { nodes: [], edges: [] } })
}
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('.react-flow__pane')
await clickTab('Database')
await page.waitForTimeout(300)
await clearActiveLayer()
await addTableAt(400, 300)
await addTableAt(800, 300)
await page.waitForTimeout(200)
const preBackspaceCount = await page.locator('.react-flow__node').count()
check('setup: 2 nodes exist before the in-field Backspace test', preBackspaceCount === 2, `count=${preBackspaceCount}`)
await page.locator('.react-flow__node').first().dblclick()
await page.waitForSelector('.table-edit')
const backspaceInput = page.locator('.table-edit__name').first()
await backspaceInput.click()
await page.keyboard.press('Control+a')
for (let i = 0; i < 20; i++) {
  await page.keyboard.press('Backspace')
}
await page.waitForTimeout(200)
const afterBackspaceCount = await page.locator('.react-flow__node').count()
check(
  'Backspace inside a text field does not delete the selected node',
  afterBackspaceCount === 2,
  `count=${afterBackspaceCount}`,
)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// ---- 12: deleting nothing does not create a history entry ----
await clearActiveLayer()
await addTableAt(500, 400)
await page.waitForTimeout(200)
// (750,200) stays clear of: the 48px left toolbar, the fixed 340px-wide
// right-hand ".side" panel (starts at x=1060 on a 1400px viewport), the
// React Flow minimap panel docked bottom-right of the canvas, and the node
// added above at (500,400) — any of which would intercept this click
// instead of the empty canvas pane.
await pane.click({ position: { x: 750, y: 200 } })
await page.waitForTimeout(150)
const preNoopDeleteCount = await page.locator('.react-flow__node').count()
check('setup: 1 node exists, nothing selected, before the no-op Delete test', preNoopDeleteCount === 1, `count=${preNoopDeleteCount}`)
await page.keyboard.press('Delete')
await page.waitForTimeout(300)
const afterNoopDeleteCount = await page.locator('.react-flow__node').count()
check('deleting nothing leaves the node count unchanged', afterNoopDeleteCount === 1, `count=${afterNoopDeleteCount}`)
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
const afterNoopDeleteUndoCount = await page.locator('.react-flow__node').count()
check(
  'deleting nothing does not consume a history entry: Ctrl+Z undoes the add, not a no-op',
  afterNoopDeleteUndoCount === 0,
  `count=${afterNoopDeleteUndoCount}`,
)

// ---- 13: save-status goes dirty immediately, then settles to "Saved" ----
// The debounce in useAutosave() fires 800ms after the store goes dirty.
// addTableAt's own internal 150ms settle-wait leaves ~650ms of headroom
// before that timer fires, so checking the status right after it returns
// should reliably still read "Unsaved changes".
await clickTab('Database')
await clearActiveLayer()
// Clearing is itself a mutation and goes through the same autosave debounce,
// so let that settle to "Saved" first — otherwise the baseline before the
// add below is indistinguishable from the dirty state we're about to assert.
await page.waitForTimeout(1000)
const statusBeforeAdd = await readSaveStatus()
check('setup: status reads "Saved" on a freshly cleared layer', statusBeforeAdd === 'Saved', `text="${statusBeforeAdd}"`)
await addTableAt(500, 400)
const statusImmediatelyAfterAdd = await readSaveStatus()
check(
  'save-status goes dirty ("Unsaved changes") immediately after an edit, before autosave fires',
  statusImmediatelyAfterAdd === 'Unsaved changes',
  `text="${statusImmediatelyAfterAdd}"`,
)
await page.waitForTimeout(1500)
const statusAfterAutosaveSettles = await readSaveStatus()
check(
  'save-status settles back to "Saved" once autosave lands',
  statusAfterAutosaveSettles === 'Saved',
  `text="${statusAfterAutosaveSettles}"`,
)

// ---- 14: no button in the header when healthy — status text only ----
const headerButtonCount = await page.locator('.header-actions button').count()
check(
  'no clickable button in .header-actions when healthy (status-only readout)',
  headerButtonCount === 0,
  `buttons=${headerButtonCount}`,
)

// ==== New checks: drag-to-draw preview visuals (visible ghost chrome) ====

// ---- N1: rect preview is visible (not the old visibility:hidden ghost) while drawing ----
await clickTab('Database')
await clearActiveLayer()
await page.keyboard.press('v')
await page.waitForTimeout(100)
await page.keyboard.press('r')
await page.waitForTimeout(150)
await page.mouse.move(500, 400)
await page.mouse.down()
await page.mouse.move(650, 520, { steps: 8 })
await page.waitForTimeout(150)
const rectPreview = page.locator('.react-flow__node-preview')
const rectPreviewVisibility = await rectPreview
  .evaluate((el) => getComputedStyle(el).visibility)
  .catch(() => 'missing')
const rectPreviewHasGhost = await rectPreview.locator('.shape-node--ghost').count()
check(
  'drag-to-draw rect preview is visible while drawing (no longer visibility:hidden)',
  rectPreviewVisibility === 'visible' && rectPreviewHasGhost === 1,
  `visibility="${rectPreviewVisibility}" ghost-count=${rectPreviewHasGhost}`,
)
await page.keyboard.press('Escape')
await page.mouse.up()
await page.waitForTimeout(150)

// ---- N2: table preview shows realistic table chrome (badge "TABLE") ----
await page.keyboard.press('t')
await page.waitForTimeout(150)
await page.mouse.move(500, 400)
await page.mouse.down()
await page.mouse.move(700, 550, { steps: 8 })
await page.waitForTimeout(150)
const tablePreview = page.locator('.react-flow__node-preview')
const badgeText = await tablePreview.locator('.schema__badge').innerText().catch(() => '')
check('drag-to-draw table preview shows table chrome badge "TABLE"', badgeText === 'TABLE', `badge="${badgeText}"`)
await page.keyboard.press('Escape')
await page.mouse.up()
await page.waitForTimeout(150)

// ---- N3: dragging back past the origin resets the anchor, not stuck at max extent ----
// The .canvas__hint readout prints "W × H" in flow units, which is robust to any
// viewport zoom/pan accumulated by earlier checks in this run (unlike raw pixel math).
await page.keyboard.press('r')
await page.waitForTimeout(150)
const anchorX = 600
const anchorY = 400
await page.mouse.move(anchorX, anchorY)
await page.mouse.down()
await page.mouse.move(anchorX + 200, anchorY + 150, { steps: 8 })
await page.waitForTimeout(100)
await page.mouse.move(anchorX - 120, anchorY - 90, { steps: 8 })
await page.waitForTimeout(150)
const hintText = await page.locator('.canvas__hint').first().innerText()
const hintMatch = hintText.match(/(\d+)\s*[×x]\s*(\d+)/)
const hintW = hintMatch ? Number(hintMatch[1]) : NaN
const hintH = hintMatch ? Number(hintMatch[2]) : NaN
check(
  'drag-back past origin resets the anchor to the new small extent (~120x90), not stuck at ~320x240',
  Math.abs(hintW - 120) <= 5 && Math.abs(hintH - 90) <= 5,
  `hint="${hintText}" parsed=${hintW}x${hintH}`,
)
await page.keyboard.press('Escape')
await page.mouse.up()
await page.waitForTimeout(150)

// ---- N4: drawn nodes are clamped up to the minimum size on release ----
await clearActiveLayer()
await page.keyboard.press('t')
await page.waitForTimeout(150)
await page.mouse.move(500, 400)
await page.mouse.down()
await page.mouse.move(540, 430, { steps: 4 }) // ~40x30 drag, well under the 260x120 table minimum
await page.mouse.up()
await page.waitForTimeout(1600)
const minSizeResp = await page.request.get(graphUrl('db'))
const minSizeJson = await minSizeResp.json()
const clampedStyle = minSizeJson.nodes?.[0]?.style
check(
  'tiny table drag is clamped to at least the 260x120 minimum size on the server',
  !!clampedStyle && clampedStyle.width >= 260 && clampedStyle.height >= 120,
  `style=${JSON.stringify(clampedStyle)}`,
)

// ==== New checks: wire tool live preview line, snap, cancel-on-far-click ====

await clearActiveLayer()
await addTableAt(200, 150)
await addTableAt(750, 150)
await page.waitForTimeout(200)
const wireNodes = page.locator('.react-flow__node')
const wireBox1 = await wireNodes.nth(0).boundingBox()
const wireBox2 = await wireNodes.nth(1).boundingBox()
check(
  'setup: 2 tables placed far apart for wire-preview checks',
  !!wireBox1 && !!wireBox2,
  `box1=${JSON.stringify(wireBox1)} box2=${JSON.stringify(wireBox2)}`,
)

// Just outside node2's left edge — within the 140-flow-unit snap radius.
const nearNode2 = { x: wireBox2.x - 40, y: wireBox2.y + wireBox2.height / 2 }
// Well clear of both nodes' bounding boxes (>140 units away from either).
const farAway = {
  x: (wireBox1.x + wireBox2.x) / 2 + 20,
  y: Math.max(wireBox1.y, wireBox2.y) + Math.max(wireBox1.height, wireBox2.height) + 350,
}

await page.keyboard.press('w')
await page.waitForTimeout(150)
await wireNodes.nth(0).click()
await page.waitForTimeout(150)
await page.mouse.move(nearNode2.x, nearNode2.y, { steps: 8 })
await page.waitForTimeout(200)
const snappedLineCount = await page.locator('.wire-preview__line--snapped').count()
const snapRingCount = await page.locator('.wire-preview__ring').count()
check(
  'wire preview: hovering just outside a node within snap range shows the snapped line + ring',
  snappedLineCount === 1 && snapRingCount === 1,
  `snappedLine=${snappedLineCount} ring=${snapRingCount}`,
)

await page.mouse.move(farAway.x, farAway.y, { steps: 8 })
await page.waitForTimeout(200)
const lineCountFar = await page.locator('.wire-preview__line').count()
const snappedLineCountFar = await page.locator('.wire-preview__line--snapped').count()
const snapRingCountFar = await page.locator('.wire-preview__ring').count()
check(
  'wire preview: moving far away keeps the plain line but drops the snapped state and ring',
  lineCountFar === 1 && snappedLineCountFar === 0 && snapRingCountFar === 0,
  `line=${lineCountFar} snappedLine=${snappedLineCountFar} ring=${snapRingCountFar}`,
)

// ---- clicking far from any node cancels wiring instead of connecting ----
await page.mouse.click(farAway.x, farAway.y)
await page.waitForTimeout(200)
const edgesAfterFarClick = await page.locator('.react-flow__edge').count()
const wireHintAfterCancel = await page.locator('.canvas__hint').first().innerText().catch(() => '')
check('clicking far from any node cancels wiring: no edge is created', edgesAfterFarClick === 0, `edges=${edgesAfterFarClick}`)
check(
  'clicking far from any node resets the wire hint back to "Click a source node"',
  wireHintAfterCancel.includes('Click a source node'),
  `hint="${wireHintAfterCancel}"`,
)

// ---- clicking within snap range of a node connects to it ----
await wireNodes.nth(0).click()
await page.waitForTimeout(150)
await page.mouse.move(nearNode2.x, nearNode2.y, { steps: 8 })
await page.waitForTimeout(200)
await page.mouse.click(nearNode2.x, nearNode2.y)
await page.waitForTimeout(200)
const edgesAfterNearClick = await page.locator('.react-flow__edge').count()
check('clicking within snap range of a node connects, creating exactly 1 edge', edgesAfterNearClick === 1, `edges=${edgesAfterNearClick}`)

// ==== Project picker: switching and creating projects ====

await page.locator('.header__project-switch').click()
await page.waitForSelector('.project-picker')
check('header "Projects" button returns to the picker', (await page.locator('.project-picker').count()) === 1)
const pickerStillListsSmoke = await page
  .locator('.project-picker__row .project-picker__open strong', { hasText: 'Smoke Test' })
  .count()
check(
  'picker still lists the smoke-test project',
  pickerStillListsSmoke >= 1,
  `rows=${pickerStillListsSmoke}`,
)

await page.locator('.project-picker__name').fill('Fresh Project')
await page.locator('.project-picker__create button[type="submit"]').click()
await page.waitForSelector('.react-flow__pane')
const headerProjectName = await page.locator('.header__project-name').innerText()
check(
  'creating a project from the picker opens it with its name in the header',
  headerProjectName === 'Fresh Project',
  `name="${headerProjectName}"`,
)
const freshProjects = (await (await page.request.get('http://localhost:8000/api/projects')).json())
  .projects
const freshProject = freshProjects.find((p) => p.name === 'Fresh Project')
if (freshProject) createdProjectIds.push(freshProject.id)
const freshNodeCount = await page.locator('.react-flow__node').count()
check('new project opens with an empty graph', freshNodeCount === 0, `nodes=${freshNodeCount}`)
const freshDirtyDots = await page.locator('.tab__dot').count()
check('new project loads without dirty flags', freshDirtyDots === 0, `dots=${freshDirtyDots}`)

// Delete only the projects this run created, leaving any pre-existing data alone.
for (const id of createdProjectIds) {
  await page.request.delete(`http://localhost:8000/api/projects/${id}`)
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
