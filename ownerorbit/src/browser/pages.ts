import type { Locator, Page } from 'playwright'
import type { SandboxSession } from './session.ts'
import { STATUS_LABEL, type Status } from '../core/types.ts'
import { closeOverlays, dialog, dialogButton, esc, exact, fill, menuItem, selectField, setSwitch, textField, until, waitToast } from './ui.ts'

/**
 * Page objects: one class per dashboard screen. Skills compose these; nothing above this layer
 * knows a CSS selector.
 */

/* ------------------------------ Menu → Overview ------------------------------ */
export class MenuOverview {
  constructor(private s: SandboxSession) {}
  private get page() { return this.s.page }

  async open() {
    await closeOverlays(this.page)
    await this.s.go('/menu/overview')
    await this.page.locator('.overview .search input').waitFor()
  }

  async search(q: string) {
    const box = this.page.locator('.overview .search input')
    await box.fill(q)
  }

  async clearSearch() {
    await this.page.locator('.overview .search input').fill('')
  }

  /** Item row by exact name (NEW chip tolerated). */
  row(name: string): Locator {
    return this.page.locator('.item-row').filter({ has: this.page.locator('.item-name', { hasText: new RegExp(`^\\s*${esc(name)}\\s*(NEW)?\\s*$`, 'i') }) }).first()
  }

  async rowStatus(name: string): Promise<string | null> {
    return this.row(name).locator('.status-btn').getAttribute('title')
  }

  /** The row-level availability dropdown, i.e. exactly what an owner clicks. */
  async setRowStatus(name: string, status: Status) {
    await this.search(name)
    const row = this.row(name)
    await row.waitFor()
    if ((await this.rowStatus(name)) === STATUS_LABEL[status]) return false
    await row.locator('.status-btn').click()
    await menuItem(this.page, STATUS_LABEL[status]).click()
    await until(async () => (await this.rowStatus(name)) === STATUS_LABEL[status], `${name} row → ${STATUS_LABEL[status]}`)
    return true
  }

  async openAdd(kind: 'Add item' | 'Add category') {
    await this.page.locator('.overview .toolbar button').filter({ hasText: exact('Add') }).click()
    await menuItem(this.page, kind).click()
  }
}

/* ------------------------------ Menu → Item detail panel ------------------------------ */
export class ItemPanel {
  constructor(private s: SandboxSession) {}
  private get page() { return this.s.page }
  get root() { return this.page.locator('.detail') }
  private get scroll() { return this.page.locator('.detail-scroll') }

  async open(itemId: string, expectName?: string) {
    await closeOverlays(this.page)
    await this.s.go(`/menu/overview?item=${encodeURIComponent(itemId)}`)
    await this.root.waitFor()
    if (expectName) await this.page.locator('.detail .crumb-current', { hasText: exact(expectName) }).waitFor()
  }

  field(label: string) {
    // Base fields live directly in .detail-scroll; size rows reuse the "Price" label, so exclude them.
    return this.scroll.locator(':scope > .tf, :scope > .grid2 > .tf, :scope > .tax-row > .tf')
      .filter({ has: this.page.locator('label.tf-label', { hasText: exact(label) }) }).locator('input, textarea').first()
  }

  async set(label: string, value: string) { await fill(this.field(label), value) }

  async setUnit(unit: string) { await selectField(this.scroll, 'Unit of Measure').selectOption({ label: unit }) }

  async setTrackInventory(on: boolean) { await setSwitch(this.scroll, 'Track Inventory', on) }

  modChip(group: string) { return this.scroll.locator('.mod-chip').filter({ hasText: exact(group) }) }

  async setModifier(group: string, on: boolean) {
    const chip = this.modChip(group)
    await chip.waitFor()
    const isOn = ((await chip.getAttribute('class')) ?? '').includes(' on')
    if (isOn !== on) await chip.click()
  }

  sizeRows() { return this.scroll.locator('.size-row') }

  async findSizeRow(name: string): Promise<Locator | null> {
    const rows = this.sizeRows()
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      const v = await textField(rows.nth(i), 'Size name').inputValue()
      if (v.trim().toLowerCase() === name.trim().toLowerCase()) return rows.nth(i)
    }
    return null
  }

  async addSize(name: string, price: string) {
    await this.scroll.locator('button.add-size').click()
    const row = this.sizeRows().last()
    await fill(textField(row, 'Size name'), name)
    await fill(textField(row, 'Price'), price)
  }

  async generateDescription() {
    const btn = this.scroll.locator('button.btn-ai')
    await btn.click()
    await until(async () => !((await btn.textContent()) ?? '').includes('Generating'), 'AI description', 15_000)
  }

  /** Click Update and wait for the app's own confirmation toast. */
  async save(name: string): Promise<string> {
    const btn = this.page.locator('.detail-foot button').filter({ hasText: exact('Update') })
    await until(async () => btn.isEnabled(), 'Update button to enable (form dirty + valid)')
    await btn.click()
    return waitToast(this.page, new RegExp(`${esc(name)} updated`, 'i'))
  }

  async more(action: 'Duplicate' | 'View on website' | 'Delete item') {
    await this.root.locator('button[aria-label="More"]').click()
    await menuItem(this.page, action).click()
  }

  /** "Update availability" dialog: status + per-provider checkboxes. */
  async availabilityDialog(status: Status, providers?: string[]) {
    await this.page.locator('.detail-foot button').filter({ hasText: exact('Update availability') }).click()
    const dlg = dialog(this.page, /^Availability/)
    await dlg.locator('label.radio').filter({ hasText: STATUS_LABEL[status] }).first().click()
    if (providers) {
      for (const box of await dlg.locator('label.checkbox').all()) {
        const label = ((await box.textContent()) ?? '').trim()
        const want = providers.some((p) => label.toLowerCase().includes(p.toLowerCase()))
        const on = ((await box.locator('.box').getAttribute('class')) ?? '').includes(' on')
        if (on !== want) await box.locator('.box').click()
      }
    }
    await dialogButton(dlg, 'Apply').click()
    return waitToast(this.page, new RegExp(STATUS_LABEL[status], 'i'))
  }
}

/* ------------------------------ Menu → header (sync, acceptance, location) ------------------------------ */
export class MenuHeader {
  constructor(private s: SandboxSession) {}
  private get page() { return this.s.page }

  async open() {
    await closeOverlays(this.page)
    if (!new URL(this.page.url()).pathname.startsWith('/menu')) await this.s.go('/menu/overview')
    await this.page.locator('.menu-header').waitFor()
  }

  async publish(): Promise<string> {
    await this.page.locator('.menu-header button').filter({ hasText: 'Update provider menus' }).click()
    return waitToast(this.page, /Menu pushed to/i, 10_000)
  }

  async acceptance(label: 'Accepting orders' | 'Pause for 15 min' | 'Pause for 30 min' | 'Pause for 60 min' | 'Stop for today') {
    await this.page.locator('.menu-header .btn-accepting').click()
    await menuItem(this.page, label).click()
  }

  async acceptanceLabel() { return ((await this.page.locator('.menu-header .btn-accepting').textContent()) ?? '').trim() }

  async switchStore(storeName: string) {
    await this.page.locator('.menu-header .btn-store').click()
    await this.page.locator('.popover .menu-item').filter({ has: this.page.locator('b', { hasText: exact(storeName) }) }).click()
    return waitToast(this.page, new RegExp(`Switched to ${esc(storeName)}`, 'i'))
  }
}

/* ------------------------------ Menu → Categories ------------------------------ */
export class CategoriesTab {
  constructor(private s: SandboxSession) {}
  private get page() { return this.s.page }

  async open() {
    await closeOverlays(this.page)
    await this.s.go('/menu/categories')
    await this.page.locator('.data-table').waitFor()
  }

  row(name: string) {
    return this.page.locator('.data-table tbody tr').filter({ has: this.page.locator('.strong-cell', { hasText: exact(name) }) }).first()
  }

  async names(): Promise<string[]> {
    return (await this.page.locator('.data-table tbody tr .strong-cell').allTextContents()).map((s) => s.trim())
  }

  async setStatus(name: string, status: Status) {
    const row = this.row(name)
    await row.locator('.status-btn').click()
    await menuItem(this.page, STATUS_LABEL[status]).click()
    await until(async () => (await row.locator('.status-btn').getAttribute('title')) === STATUS_LABEL[status], `${name} → ${STATUS_LABEL[status]}`)
  }

  async move(name: string, dir: 'up' | 'down') {
    const btn = this.row(name).locator(`button[aria-label="Move ${dir}"]`)
    if (await btn.isDisabled()) return false
    const before = await this.names()
    await btn.click()
    await until(async () => (await this.names()).join() !== before.join(), `${name} to move ${dir}`)
    return true
  }

  async edit(name: string, patch: { name?: string; description?: string }) {
    await this.row(name).locator('button[aria-label="Edit"]').click()
    const dlg = dialog(this.page, 'Edit category')
    if (patch.name !== undefined) await fill(textField(dlg, 'Name'), patch.name)
    if (patch.description !== undefined) await fill(textField(dlg, 'Description (optional)'), patch.description)
    await dialogButton(dlg, 'Save').click()
    return waitToast(this.page, /Category saved/i)
  }

  async create(name: string, description = '') {
    await this.page.locator('.table-toolbar button').filter({ hasText: 'Add category' }).click()
    const dlg = dialog(this.page, 'Add category')
    await fill(textField(dlg, 'Name'), name)
    if (description) await fill(textField(dlg, 'Description (optional)'), description)
    await dialogButton(dlg, 'Add').click()
    return waitToast(this.page, new RegExp(`${esc(name)} added`, 'i'))
  }

  async remove(name: string) {
    await this.row(name).locator('button[aria-label="Delete"]').click()
    const dlg = dialog(this.page, 'Delete category?')
    await dialogButton(dlg, 'Delete').click()
    return waitToast(this.page, new RegExp(`${esc(name)} deleted`, 'i'))
  }
}

/* ------------------------------ Menu → Modifier groups ------------------------------ */
export class ModifierGroupsTab {
  constructor(private s: SandboxSession) {}
  private get page() { return this.s.page }

  async open() {
    await closeOverlays(this.page)
    await this.s.go('/menu/modifier-groups')
    await this.page.locator('.mod-grid').waitFor()
  }

  async openGroup(name: string | null) {
    if (name === null) {
      await this.page.locator('.table-toolbar button').filter({ hasText: 'Add group' }).click()
      return dialog(this.page, 'New modifier group')
    }
    await this.page.locator('.mod-card').filter({ has: this.page.locator('.mod-title', { hasText: exact(name) }) }).click()
    return dialog(this.page, 'Edit modifier group')
  }

  async optionRow(dlg: Locator, option: string): Promise<Locator | null> {
    const rows = dlg.locator('.size-row')
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      if ((await textField(rows.nth(i), 'Option').inputValue()).trim().toLowerCase() === option.trim().toLowerCase()) return rows.nth(i)
    }
    return null
  }
}

/* ------------------------------ Orders ------------------------------ */
export class OrdersScreen {
  constructor(private s: SandboxSession) {}
  private get page() { return this.s.page }

  async openTicket(orderId: string, number: string) {
    await closeOverlays(this.page)
    await this.s.go(`/orders?o=${encodeURIComponent(orderId)}`)
    await this.page.locator('.ticket h2', { hasText: exact(number) }).waitFor()
  }

  async ticketStatus() { return ((await this.page.locator('.ticket-head .status-pill').textContent()) ?? '').trim() }

  async press(label: 'Accept & prepare' | 'Mark ready' | 'Complete' | 'Reject') {
    const before = await this.ticketStatus()
    await this.page.locator('.ticket-actions button').filter({ hasText: exact(label) }).click()
    await until(async () => (await this.ticketStatus()) !== before, `ticket status to change after "${label}"`)
  }
}

/* ------------------------------ Read-only screens ------------------------------ */
export async function readStats(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const card of await page.locator('.stat').all()) {
    const k = ((await card.locator('.stat-label').textContent()) ?? '').trim()
    out[k] = ((await card.locator('.stat-value').textContent()) ?? '').trim()
  }
  return out
}

export async function readBars(scope: Locator): Promise<{ label: string; value: string }[]> {
  const rows: { label: string; value: string }[] = []
  for (const li of await scope.locator('li').all()) {
    rows.push({ label: ((await li.locator('span').first().textContent()) ?? '').trim(), value: ((await li.locator('b').textContent()) ?? '').trim() })
  }
  return rows
}

export function card(page: Page, title: string) {
  return page.locator('.card').filter({ has: page.locator('.card-title', { hasText: exact(title) }) }).first()
}
