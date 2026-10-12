import type { Locator, Page } from 'playwright'

/**
 * Drivers for the dashboard's hand-rolled MUI-style components (src/ui.tsx in orders-dashboard).
 * The app has no test ids, so everything is anchored on visible labels + component class names.
 */

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const exact = (s: string) => new RegExp(`^\\s*${esc(s)}\\s*$`, 'i')

type Scope = Page | Locator
// `has:` filters must be built from the page, not the scope, or Playwright double-applies the scope.
const root = (scope: Scope): Page => ('page' in scope && typeof scope.page === 'function' ? scope.page() : scope) as Page

/** <TextField label="…"> → its <input>/<textarea>. Only direct-match labels, so "Price" ≠ "Price range". */
export function textField(scope: Scope, label: string): Locator {
  return scope.locator('.tf').filter({ has: root(scope).locator('label.tf-label', { hasText: exact(label) }) }).locator('input, textarea').first()
}

export function selectField(scope: Scope, label: string): Locator {
  return scope.locator('.tf.select').filter({ has: root(scope).locator('label.tf-label', { hasText: exact(label) }) }).locator('select').first()
}

export async function fill(field: Locator, value: string) {
  await field.click()
  await field.fill(value)
  const got = await field.inputValue()
  if (got !== value) {
    // Controlled inputs may sanitise (e.g. price strips non-numerics); retype as keystrokes once.
    await field.fill('')
    await field.pressSequentially(value, { delay: 10 })
  }
}

/** <Switch label="…"> → current state + setter. */
export async function setSwitch(scope: Scope, label: string | RegExp, on: boolean) {
  const wrap = scope.locator('.switch-wrap').filter({ hasText: label }).first()
  const sw = wrap.locator('[role="switch"]')
  if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click()
  await until(async () => (await sw.getAttribute('aria-checked')) === String(on), `switch "${label}" → ${on}`)
}

/** Poll an async predicate (the DOM re-renders asynchronously after React state updates). */
export async function until(pred: () => Promise<boolean>, what: string, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 80))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export async function setCheckbox(scope: Scope, label: string, on: boolean) {
  const box = scope.locator('label.checkbox').filter({ hasText: exact(label) }).locator('.box')
  const isOn = ((await box.getAttribute('class')) ?? '').includes(' on')
  if (isOn !== on) await box.click()
}

export async function chooseRadio(scope: Scope, label: string) {
  await scope.locator('label.radio').filter({ has: root(scope).locator('.radio-label', { hasText: exact(label) }) }).click()
}

/** Portaled dialog by its title. */
export function dialog(page: Page, title: string | RegExp): Locator {
  return page.locator('[role="dialog"]').filter({ has: page.locator('.dialog-title', { hasText: title }) })
}

export function dialogButton(dlg: Locator, name: string): Locator {
  return dlg.locator('.dialog-actions button').filter({ hasText: exact(name) })
}

/** Portaled popover menu item. */
export function menuItem(page: Page, text: string | RegExp): Locator {
  return page.locator('.popover .menu-item').filter({ hasText: typeof text === 'string' ? exact(text) : text }).first()
}

/** Wait for a toast and return its text (evidence of what the app itself reported). */
export async function waitToast(page: Page, pattern: RegExp, timeout = 6000): Promise<string> {
  const t = page.locator('.toast').filter({ hasText: pattern }).last()
  await t.waitFor({ timeout })
  return ((await t.textContent()) ?? '').trim()
}

export async function closeOverlays(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('.popover, [role="dialog"]').count())) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(80)
  }
}
