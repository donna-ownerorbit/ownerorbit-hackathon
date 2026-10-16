import { z } from 'zod'
import { CategoriesTab, MenuHeader, ModifierGroupsTab } from '../browser/pages.ts'
import { dialogButton, fill, setSwitch, textField, waitToast } from '../browser/ui.ts'
import { SkillError, STATUS_LABEL, type ModifierGroup, type Skill } from '../core/types.ts'
import { check, findCategory, findGroup, list, money, near, statusLabel, verdict, zStatus } from './common.ts'

const def = <I extends Record<string, unknown>>(s: Skill<I>) => s as unknown as Skill

/* 13 ─────────────────────────────── category status */
const CatStatus = z.object({ category: z.string(), status: zStatus })
export const setCategoryStatus = def<z.infer<typeof CatStatus>>({
  id: 'menu.category.set_status', title: 'Turn a whole category on/off',
  description: 'Set the availability of an entire category (e.g. hide Kids Meal after 9pm) from Menu → Categories.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: CatStatus,
  examples: ['hide the kids meal category', 'turn the starters category back on', 'mark the burgers section sold out today'],
  alreadyDone: (i, s) => { const c = findCategory(s, i.category); return c.status === i.status ? `${c.name} is already ${statusLabel(i.status)}.` : null },
  async run({ session, before }, i) {
    const c = findCategory(before, i.category)
    const tab = new CategoriesTab(session)
    await tab.open()
    await tab.setStatus(c.name, i.status)
    return { summary: `${c.name} category is now ${statusLabel(i.status)}`, touched: 1, data: { id: c.id } }
  },
  verify: async ({ after, session, output }, i) => {
    const c = after.categories.find((x) => x.id === (output.data as { id: string }).id)
    const tab = new CategoriesTab(session)
    await tab.open()
    return verdict([check('status', i.status, c?.status), check('UI', STATUS_LABEL[i.status], await tab.row(c!.name).locator('.status-btn').getAttribute('title'))])
  },
  inverse: (i, before) => [{ skill: 'menu.category.set_status', input: { category: i.category, status: findCategory(before, i.category).status } }],
})

/* 14 ─────────────────────────────── create category */
const CatCreate = z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional() })
export const createCategory = def<z.infer<typeof CatCreate>>({
  id: 'menu.category.create', title: 'Add a category',
  description: 'Create a new menu category.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: CatCreate,
  examples: ['add a Drinks category', 'create a new category called Desserts — sweet endings'],
  precheck: (i, s) => { if (s.categories.some((c) => c.name.toLowerCase() === i.name.toLowerCase())) throw new SkillError(`${i.name} already exists.`) },
  async run({ session }, i) {
    const tab = new CategoriesTab(session)
    await tab.open()
    await tab.create(i.name, i.description)
    return { summary: `Added the ${i.name} category`, touched: 1 }
  },
  verify: ({ after }, i) => { const c = after.categories.find((x) => x.name === i.name); return verdict([check('exists', true, !!c), check('status', 'available', c?.status)]) },
  inverse: (i) => [{ skill: 'menu.category.delete', input: { category: i.name } }],
})

/* 15 ─────────────────────────────── edit category */
const CatEdit = z.object({ category: z.string(), newName: z.string().max(80).optional(), description: z.string().max(500).optional() })
export const editCategory = def<z.infer<typeof CatEdit>>({
  id: 'menu.category.edit', title: 'Rename / describe a category',
  description: 'Rename a category or change its description.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: CatEdit,
  examples: ['rename the starters category to Appetizers', 'set the wraps description to Make it a meal for $4.99'],
  precheck: (i) => { if (i.newName === undefined && i.description === undefined) throw new SkillError('What should change — the name or the description?') },
  async run({ session, before }, i) {
    const c = findCategory(before, i.category)
    const tab = new CategoriesTab(session)
    await tab.open()
    await tab.edit(c.name, { name: i.newName, description: i.description })
    return { summary: [i.newName && `Renamed ${c.name} → ${i.newName}`, i.description !== undefined && `${i.newName ?? c.name} description updated`].filter(Boolean).join('; '), touched: 1, data: { id: c.id } }
  },
  verify: ({ after, output }, i) => {
    const c = after.categories.find((x) => x.id === (output.data as { id: string }).id)
    return verdict([...(i.newName ? [check('name', i.newName, c?.name)] : []), ...(i.description !== undefined ? [check('description', i.description, c?.description)] : [])])
  },
  inverse: (i, before) => { const c = findCategory(before, i.category); return [{ skill: 'menu.category.edit', input: { category: i.newName ?? c.name, newName: c.name, description: c.description } }] },
})

/* 16 ─────────────────────────────── reorder category */
const CatMove = z.object({ category: z.string(), to: z.union([z.enum(['up', 'down', 'top', 'bottom']), z.number().int().min(1)]).describe('up/down one slot, top/bottom, or a 1-based position') })
export const reorderCategory = def<z.infer<typeof CatMove>>({
  id: 'menu.category.reorder', title: 'Reorder categories',
  description: 'Move a category up/down, to the top/bottom, or to a specific position (order is mirrored on every provider).',
  domain: 'menu', risk: 'write', minRole: 'manager', input: CatMove,
  examples: ['move burgers to the top', 'put kids meal last', 'move sides up one', 'make entrees the 2nd category'],
  alreadyDone: (i, s) => (s.categories.findIndex((c) => c.id === findCategory(s, i.category).id) === targetIndex(i.to, s.categories.findIndex((c) => c.id === findCategory(s, i.category).id), s.categories.length) ? `${findCategory(s, i.category).name} is already there.` : null),
  async run({ session, before }, i) {
    const c = findCategory(before, i.category)
    const from = before.categories.findIndex((x) => x.id === c.id)
    const to = targetIndex(i.to, from, before.categories.length)
    const tab = new CategoriesTab(session)
    await tab.open()
    for (let k = 0; k < Math.abs(to - from); k++) await tab.move(c.name, to < from ? 'up' : 'down')
    return { summary: `${c.name} moved to position ${to + 1} of ${before.categories.length}`, touched: 1, data: { id: c.id, to, from } }
  },
  verify: ({ after, output }) => { const d = output.data as { id: string; to: number }; return verdict([check('position', d.to + 1, after.categories.findIndex((x) => x.id === d.id) + 1)]) },
  inverse: (i, _b, out) => [{ skill: 'menu.category.reorder', input: { category: i.category, to: (out.data as { from: number }).from + 1 } }],
})
function targetIndex(to: 'up' | 'down' | 'top' | 'bottom' | number, from: number, n: number) {
  const t = to === 'up' ? from - 1 : to === 'down' ? from + 1 : to === 'top' ? 0 : to === 'bottom' ? n - 1 : to - 1
  return Math.max(0, Math.min(n - 1, t))
}

/* 17 ─────────────────────────────── delete category */
const CatDel = z.object({ category: z.string() })
export const deleteCategory = def<z.infer<typeof CatDel>>({
  id: 'menu.category.delete', title: 'Delete a category',
  description: 'Delete a category AND every item inside it. Destructive; always confirmed.',
  domain: 'menu', risk: 'destructive', minRole: 'owner', input: CatDel,
  examples: ['delete the kids meal category', 'get rid of the sides section'],
  confirm: (i, s) => { const c = findCategory(s, i.category); const n = s.items.filter((x) => x.categoryId === c.id).length; return `This deletes ${c.name} and its ${n} item${n === 1 ? '' : 's'}.` },
  async run({ session, before }, i) {
    const c = findCategory(before, i.category)
    const tab = new CategoriesTab(session)
    await tab.open()
    await tab.remove(c.name)
    const n = before.items.filter((x) => x.categoryId === c.id).length
    return { summary: `Deleted ${c.name} (${n} items)`, touched: 1 + n, data: { id: c.id } }
  },
  verify: ({ after, output }) => { const id = (output.data as { id: string }).id; return verdict([check('category gone', false, after.categories.some((x) => x.id === id)), check('items gone', 0, after.items.filter((x) => x.categoryId === id).length)]) },
})

/* 18 ─────────────────────────────── modifier groups */
const ModUpsert = z.object({
  group: z.string().describe('Existing group name, or the new group name when create=true'),
  create: z.boolean().optional(),
  addOptions: z.array(z.object({ name: z.string(), price: z.number().min(0).default(0) })).optional(),
  removeOptions: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
  rename: z.string().optional(),
})
type ModIn = z.infer<typeof ModUpsert>
export const upsertModifierGroup = def<ModIn>({
  id: 'menu.modifier_group.upsert', title: 'Edit / create a modifier group',
  description: 'Create a modifier group, add/reprice/remove options, toggle required, set min/max picks.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: ModUpsert,
  examples: ['add Ranch for 50 cents to wing sauce', 'remove buffalo from wing sauce', 'make entree sauce optional', 'create a modifier group Dressing with Ranch, Caesar and Tahini', 'let people pick up to 3 extras'],
  precheck: (i, s) => {
    if (i.create && s.modifierGroups.some((g) => g.name.toLowerCase() === i.group.toLowerCase())) throw new SkillError(`${i.group} already exists.`)
    if (!i.create) { const g = findGroup(s, i.group); for (const o of i.removeOptions ?? []) if (!g.options.some((x) => x.name.toLowerCase() === o.toLowerCase())) throw new SkillError(`${g.name} has no "${o}" option (has ${list(g.options.map((x) => x.name))}).`) }
  },
  async run({ session, before }, i) {
    const tab = new ModifierGroupsTab(session)
    await tab.open()
    const existing = i.create ? null : findGroup(before, i.group)
    const dlg = await tab.openGroup(existing?.name ?? null)
    if (i.create || i.rename) await fill(textField(dlg, 'Group name'), i.rename ?? i.group)
    if (i.required !== undefined) await setSwitch(dlg, 'Customer must choose', i.required)
    if (i.min !== undefined) await fill(textField(dlg, 'Min selections'), String(i.min))
    if (i.max !== undefined) await fill(textField(dlg, 'Max selections'), String(i.max))
    for (const name of i.removeOptions ?? []) await (await tab.optionRow(dlg, name))!.locator('button[aria-label="Remove"]').click()
    for (const o of i.addOptions ?? []) {
      const row = await tab.optionRow(dlg, o.name)
      if (row) { await fill(textField(row, 'Price'), String(o.price)); continue }
      await dlg.locator('button').filter({ hasText: 'Add option' }).click()
      const last = dlg.locator('.size-row').last()
      await fill(textField(last, 'Option'), o.name)
      await fill(textField(last, 'Price'), String(o.price))
    }
    await dialogButton(dlg, 'Save').click()
    const name = i.rename ?? existing?.name ?? i.group
    await waitToast(session.page, /saved/i)
    const bits = [
      i.create && 'created',
      i.addOptions?.length && `+${list(i.addOptions.map((o) => `${o.name}${o.price ? ` (+${money(o.price)})` : ''}`))}`,
      i.removeOptions?.length && `−${list(i.removeOptions)}`,
      i.required !== undefined && (i.required ? 'now required' : 'now optional'),
      (i.min !== undefined || i.max !== undefined) && `picks ${i.min ?? existing?.min ?? 0}–${i.max ?? existing?.max ?? 1}`,
      i.rename && `renamed from ${existing?.name}`,
    ].filter(Boolean)
    return { summary: `${name}: ${bits.join(', ')}`, touched: 1, data: { name, before: existing } }
  },
  verify: ({ after, output }, i) => {
    const d = output.data as { name: string }
    const g = after.modifierGroups.find((x) => x.name === d.name)
    const checks = [check('group exists', true, !!g)]
    for (const o of i.addOptions ?? []) { const got = g?.options.find((x) => x.name.toLowerCase() === o.name.toLowerCase()); checks.push(check(`option ${o.name}`, o.price, got?.price, !!got && near(got.price, o.price))) }
    for (const o of i.removeOptions ?? []) checks.push(check(`option ${o} removed`, false, !!g?.options.some((x) => x.name.toLowerCase() === o.toLowerCase())))
    if (i.required !== undefined) checks.push(check('required', i.required, g?.required))
    if (i.max !== undefined) checks.push(check('max', i.max, g?.max))
    if (i.min !== undefined) checks.push(check('min', i.min, g?.min))
    return verdict(checks)
  },
  inverse: (i, _b, out) => {
    const prev = (out.data as { before: ModifierGroup | null; name: string }).before
    if (!prev) return null
    const current = (out.data as { name: string }).name
    return [{
      skill: 'menu.modifier_group.upsert',
      input: {
        group: current, rename: current !== prev.name ? prev.name : undefined, required: prev.required, min: prev.min, max: prev.max,
        removeOptions: (i.addOptions ?? []).filter((o) => !prev.options.some((p) => p.name.toLowerCase() === o.name.toLowerCase())).map((o) => o.name),
        addOptions: prev.options.filter((p) => (i.removeOptions ?? []).some((r) => r.toLowerCase() === p.name.toLowerCase()) || (i.addOptions ?? []).some((o) => o.name.toLowerCase() === p.name.toLowerCase())).map((p) => ({ name: p.name, price: p.price })),
      },
    }]
  },
})

/* 19 ─────────────────────────────── publish to providers */
export const publishMenu = def<Record<string, never>>({
  id: 'menu.publish', title: 'Push menu to providers',
  description: 'Press "Update provider menus" to push the current menu to the website, DoorDash, Uber Eats and Grubhub.',
  domain: 'menu', risk: 'write', minRole: 'staff', input: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  examples: ['push the menu', 'sync the menu to doordash and ubereats', 'publish menu changes', 'update provider menus'],
  async run({ session }) {
    const h = new MenuHeader(session)
    await h.open()
    const toast = await h.publish()
    return { summary: toast.replace(/^.*?Menu/, 'Menu'), touched: 1 }
  },
  verify: ({ after, before }) => verdict([check('menuSyncedAt advanced', true, after.restaurant.menuSyncedAt > before.restaurant.menuSyncedAt)]),
})

export const menuStructureSkills: Skill[] = [setCategoryStatus, createCategory, editCategory, reorderCategory, deleteCategory, upsertModifierGroup, publishMenu]
