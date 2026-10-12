import { z } from 'zod'
import { bxAvailable, bxExecute, bxNote, bxSucceeded, BxUnavailable } from '../integrations/browser-exec.ts'
import { ItemPanel, MenuOverview } from '../browser/pages.ts'
import { dialog, dialogButton, fill, selectField, textField, waitToast } from '../browser/ui.ts'
import { SkillError, STATUS_LABEL, type Item, type Skill } from '../core/types.ts'
import { check, expandItems, findCategory, findGroup, findItem, list, money, near, roundPrice, statusLabel, verdict, zStatus } from './common.ts'

const def = <I extends Record<string, unknown>>(s: Skill<I>) => s as unknown as Skill

/* 1 ─────────────────────────────── availability (single, multi, whole category) */
const SetAvailability = z.object({
  items: z.array(z.string()).optional().describe('Exact item names'),
  category: z.string().optional().describe('Apply to every item in this category'),
  status: zStatus.describe('available | sold_out_today (86 / unavailable) | sold_out (indefinitely) | hidden'),
  providers: z.array(z.string()).optional().describe('Limit to these providers (single item only)'),
})
export const setAvailability = def<z.infer<typeof SetAvailability>>({
  id: 'menu.item.set_availability',
  title: 'Mark items available / 86 / hidden',
  description: 'Change availability of one or more menu items (or every item in a category) using the row availability control on Menu → Overview.',
  domain: 'menu', risk: 'write', minRole: 'staff', input: SetAvailability,
  examples: ['86 the chicken nuggets', 'mark chicken nuggets unavailable', 'we are out of lamb chops and dolma', 'nuggets are back', 'hide the salmon burger', 'sold out of calamari indefinitely', '86 everything in kids meal'],
  confirm: (i, s) => {
    const n = expandItems(s, i.items, i.category).length
    return n > 5 ? `That changes ${n} items.` : null
  },
  alreadyDone: (i, s) => {
    const items = expandItems(s, i.items, i.category)
    return items.every((x) => x.status === i.status) ? `${list(items.map((x) => x.name))} ${items.length > 1 ? 'are' : 'is'} already ${statusLabel(i.status)}.` : null
  },
  async run({ session, before, actor, log }, i) {
    const items = expandItems(before, i.items, i.category).filter((x) => x.status !== i.status)
    // browser-exec covers whole-menu status changes; provider-specific changes stay on the item panel.
    const bxSkill = ({ sold_out_today: 'middleware.mark_item_unavailable', sold_out: 'middleware.mark_item_sold_out', available: 'middleware.mark_item_available' } as Record<string, string>)[i.status]
    // browser-exec always drives the PRODUCTION dashboard, so only delegate when this session is live too.
    if (actor && session.apiMode === 'live' && bxSkill && !i.providers?.length && items.length && await bxAvailable(bxSkill)) {
      try {
        const runs = []
        for (const it of items) {
          const r = await bxExecute(bxSkill, { itemId: it.id }, actor)
          if (!bxSucceeded(r)) throw new SkillError(`browser-exec couldn't confirm ${it.name}: ${r.message}`)
          runs.push(r)
        }
        log(`browser-exec: ${runs.map((r) => r.status).join(', ')}`)
        return {
          summary: `${list(items.map((x) => x.name))} ${items.length > 1 ? 'are' : 'is'} now ${statusLabel(i.status)} on all 4 providers (${bxNote(runs.at(-1)!)})`,
          touched: items.length, data: { ids: items.map((x) => x.id), via: 'browser-exec', browserExec: runs.map((r) => ({ status: r.status, attempts: r.attempts, providers: r.confirmation?.status ?? null })) },
        }
      } catch (e) {
        if (!(e instanceof BxUnavailable)) throw e
        log('browser-exec unreachable — using the built-in skill')
      }
    }
    if (i.providers?.length && items.length === 1) {
      const panel = new ItemPanel(session)
      await panel.open(items[0].id, items[0].name)
      await panel.availabilityDialog(i.status, i.providers)
    } else {
      const ov = new MenuOverview(session)
      await ov.open()
      for (const it of items) await ov.setRowStatus(it.name, i.status)
      await ov.clearSearch()
    }
    const where = i.providers?.length ? `on ${list(i.providers)}` : 'on all 4 providers'
    return { summary: `${list(items.map((x) => x.name))} ${items.length > 1 ? 'are' : 'is'} now ${statusLabel(i.status)} ${where}`, touched: items.length, data: { ids: items.map((x) => x.id) } }
  },
  verify: async ({ after, session, before, output }, i) => {
    const ids = expandItems(before, i.items, i.category).map((x) => x.id)
    const checks = ids.map((id) => {
      const it = after.items.find((x) => x.id === id)
      return check(`${it?.name ?? id}.status`, i.status, it?.status)
    })
    // browser-exec already proved persisted state and the rendered row agree (uiAgrees) on a fresh page;
    // our own check stays independent (fresh /api/state read above) without repeating the UI pass.
    if ((output.data as { via?: string } | undefined)?.via === 'browser-exec') return verdict(checks)
    // Also prove it renders that way in the UI after reload (what customers' menus are built from).
    const ov = new MenuOverview(session)
    await ov.open()
    for (const id of ids.slice(0, 3)) {
      const name = after.items.find((x) => x.id === id)!.name
      await ov.search(name)
      checks.push(check(`UI row "${name}"`, STATUS_LABEL[i.status], await ov.rowStatus(name)))
    }
    await ov.clearSearch()
    return verdict(checks)
  },
  inverse: (i, before) => {
    const items = expandItems(before, i.items, i.category)
    const byStatus = new Map<string, string[]>()
    for (const it of items) byStatus.set(it.status, [...(byStatus.get(it.status) ?? []), it.name])
    return [...byStatus].map(([status, names]) => ({ skill: 'menu.item.set_availability', input: { items: names, status } }))
  },
})

/* 2 ─────────────────────────────── price (absolute / +$ / +%) */
const SetPrice = z.object({
  item: z.string(),
  price: z.number().min(0).max(10000).optional().describe('New absolute price'),
  delta: z.number().optional().describe('Add/subtract dollars'),
  percent: z.number().optional().describe('Add/subtract percent'),
})
function nextPrice(it: Item, i: { price?: number; delta?: number; percent?: number }) {
  if (i.price !== undefined) return roundPrice(i.price)
  if (i.delta !== undefined) return roundPrice(it.price + i.delta)
  if (i.percent !== undefined) return roundPrice(it.price * (1 + i.percent / 100))
  throw new SkillError('What price should it be?')
}
export const setPrice = def<z.infer<typeof SetPrice>>({
  id: 'menu.item.set_price',
  title: 'Change an item price',
  description: 'Set an item base price, or move it by dollars or percent, via the item detail panel.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: SetPrice,
  examples: ['change flame burger to $17.99', 'raise wings by $1', 'drop the dolma price 10%', 'falafel wrap is 11.49 now'],
  precheck: (i, s) => { const p = nextPrice(findItem(s, i.item), i); if (p <= 0) throw new SkillError(`That would make it ${money(p)}.`) },
  confirm: (i, s) => {
    const it = findItem(s, i.item), p = nextPrice(it, i)
    return Math.abs(p - it.price) / it.price > 0.3 ? `${it.name} would go from ${money(it.price)} to ${money(p)} (${Math.round(((p - it.price) / it.price) * 100)}%).` : null
  },
  alreadyDone: (i, s) => { const it = findItem(s, i.item); return near(it.price, nextPrice(it, i)) ? `${it.name} is already ${money(it.price)}.` : null },
  async run({ session, before, actor, log }, i) {
    const it = findItem(before, i.item), p = nextPrice(it, i)
    if (actor && session.apiMode === 'live' && p <= 500 && await bxAvailable('middleware.change_price')) {
      try {
        // Our approval policy already ran (role check + owner YES where required); pass it on as the approval id.
        const r = await bxExecute('middleware.change_price', { itemId: it.id, newPrice: p }, actor, { approvalId: `ownerorbit:${actor.actionId}` })
        if (!bxSucceeded(r)) throw new SkillError(`browser-exec couldn't confirm the price of ${it.name}: ${r.message}`)
        log(`browser-exec: ${r.status}`)
        return { summary: `${it.name}: ${money(it.price)} → ${money(p)} (${bxNote(r)})`, touched: 1, data: { id: it.id, from: it.price, to: p, via: 'browser-exec', browserExec: [{ status: r.status, attempts: r.attempts, providers: r.confirmation?.status ?? null }] } }
      } catch (e) {
        if (!(e instanceof BxUnavailable)) throw e
        log('browser-exec unreachable — using the built-in skill')
      }
    }
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    await panel.set('Price', p.toFixed(2))
    await panel.save(it.name)
    return { summary: `${it.name}: ${money(it.price)} → ${money(p)}`, touched: 1, data: { id: it.id, from: it.price, to: p } }
  },
  verify: ({ after, output }) => {
    const d = output.data as { id: string; to: number }
    const it = after.items.find((x) => x.id === d.id)
    return verdict([check('price', d.to, it?.price, near(d.to, it?.price ?? -1))])
  },
  inverse: (i, before) => [{ skill: 'menu.item.set_price', input: { item: findItem(before, i.item).name, price: findItem(before, i.item).price } }],
})

/* 3 ─────────────────────────────── bulk price adjust */
const AdjustPrices = z.object({
  items: z.array(z.string()).optional(),
  category: z.string().optional(),
  percent: z.number().optional(),
  amount: z.number().optional(),
  rounding: z.enum(['cents', 'nines']).default('cents').describe('nines = end every price in .99'),
})
export const adjustPrices = def<z.infer<typeof AdjustPrices>>({
  id: 'menu.items.adjust_prices',
  title: 'Bulk price adjustment',
  description: 'Raise or lower prices for a set of items or a whole category by a percent or dollar amount, optional .99 rounding.',
  domain: 'menu', risk: 'write', minRole: 'owner', input: AdjustPrices,
  examples: ['raise all burgers 5%', 'add 50 cents to every wrap', 'cut kids meal prices by $1', 'raise entrees 3% and round to .99'],
  precheck: (i) => { if (i.percent === undefined && i.amount === undefined) throw new SkillError('By how much? Say a percent or a dollar amount.') },
  confirm: (i, s) => {
    const items = expandItems(s, i.items, i.category)
    const preview = items.slice(0, 3).map((it) => `${it.name} ${money(it.price)}→${money(target(it, i))}`).join(', ')
    return `Reprice ${items.length} item${items.length > 1 ? 's' : ''}: ${preview}${items.length > 3 ? ', …' : ''}.`
  },
  async run({ session, before }, i) {
    const items = expandItems(before, i.items, i.category)
    const panel = new ItemPanel(session)
    const changes: { id: string; name: string; from: number; to: number }[] = []
    for (const it of items) {
      const to = target(it, i)
      if (near(to, it.price)) continue
      await panel.open(it.id, it.name)
      await panel.set('Price', to.toFixed(2))
      await panel.save(it.name)
      changes.push({ id: it.id, name: it.name, from: it.price, to })
    }
    const how = i.percent !== undefined ? `${i.percent > 0 ? '+' : ''}${i.percent}%` : `${(i.amount ?? 0) > 0 ? '+' : '-'}${money(Math.abs(i.amount ?? 0))}`
    return { summary: `Repriced ${changes.length} item${changes.length === 1 ? '' : 's'} ${how}${i.rounding === 'nines' ? ' (rounded to .99)' : ''}`, touched: changes.length, data: { changes } }
  },
  verify: ({ after, output }) => {
    const { changes } = output.data as { changes: { id: string; name: string; to: number }[] }
    return verdict(changes.map((c) => check(`${c.name}.price`, c.to, after.items.find((x) => x.id === c.id)?.price, near(c.to, after.items.find((x) => x.id === c.id)?.price ?? -1))))
  },
  inverse: (_i, before, out) => (out.data as { changes: { id: string; from: number }[] }).changes.map((c) => ({ skill: 'menu.item.set_price', input: { item: before.items.find((x) => x.id === c.id)!.name, price: c.from } })),
})
function target(it: Item, i: { percent?: number; amount?: number; rounding?: 'cents' | 'nines' }) {
  const raw = i.percent !== undefined ? it.price * (1 + i.percent / 100) : it.price + (i.amount ?? 0)
  return roundPrice(Math.max(0, raw), i.rounding === 'nines' ? 'nines' : 'cents')
}

/* 4 ─────────────────────────────── rename */
const Rename = z.object({ item: z.string(), newName: z.string().min(1).max(120) })
export const renameItem = def<z.infer<typeof Rename>>({
  id: 'menu.item.rename', title: 'Rename an item',
  description: 'Rename a menu item everywhere (all providers pick up the new name on the next sync).',
  domain: 'menu', risk: 'write', minRole: 'manager', input: Rename,
  examples: ['rename flame burger to Inferno Burger', 'call the jumbo wrap the Mega Wrap'],
  precheck: (i, s) => { if (s.items.some((x) => x.name.toLowerCase() === i.newName.toLowerCase() && x.id !== findItem(s, i.item).id)) throw new SkillError(`There's already an item called ${i.newName}.`) },
  alreadyDone: (i, s) => (findItem(s, i.item).name === i.newName ? `It's already called ${i.newName}.` : null),
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    await panel.set('Name', i.newName)
    await panel.save(i.newName)
    return { summary: `Renamed ${it.name} → ${i.newName}`, touched: 1, data: { id: it.id, from: it.name } }
  },
  verify: ({ after, output }, i) => verdict([check('name', i.newName, after.items.find((x) => x.id === (output.data as { id: string }).id)?.name)]),
  inverse: (i, _b, out) => [{ skill: 'menu.item.rename', input: { item: i.newName, newName: (out.data as { from: string }).from } }],
})

/* 5 ─────────────────────────────── description (write or AI-generate) */
const Describe = z.object({ item: z.string(), description: z.string().max(1200).optional(), generate: z.boolean().optional().describe('Use the dashboard "Generate with AI" button') })
export const setDescription = def<z.infer<typeof Describe>>({
  id: 'menu.item.set_description', title: 'Write / generate a description',
  description: 'Set an item description verbatim, or press the dashboard\'s "Generate with AI" button and save the result.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: Describe,
  examples: ['write a description for the fried calamari', 'set the onion rings description to Thick-cut, beer battered.', 'generate a new description for chicken tenders'],
  precheck: (i) => { if (!i.description && !i.generate) throw new SkillError('Want me to write one with AI, or what should it say?') },
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    if (i.generate || !i.description) await panel.generateDescription()
    else await panel.set('Description (optional)', i.description)
    const text = await panel.field('Description (optional)').inputValue()
    if (text === it.description) return { summary: `${it.name} already had that description`, touched: 0, data: { id: it.id, text, from: it.description } }
    await panel.save(it.name)
    return { summary: `${it.name} description: "${text.length > 90 ? text.slice(0, 87) + '…' : text}"`, touched: 1, data: { id: it.id, text, from: it.description } }
  },
  verify: ({ after, output }) => { const d = output.data as { id: string; text: string }; return verdict([check('description', d.text, after.items.find((x) => x.id === d.id)?.description)]) },
  inverse: (i, before, out) => [{ skill: 'menu.item.set_description', input: { item: findItem(before, i.item).name, description: (out.data as { from: string }).from || ' ' } }],
})

/* 6 ─────────────────────────────── create */
const Create = z.object({
  name: z.string().min(1).max(120), price: z.number().min(0).max(10000), category: z.string(),
  description: z.string().max(1200).optional(), unit: z.string().optional(),
})
export const createItem = def<z.infer<typeof Create>>({
  id: 'menu.item.create', title: 'Add a new item',
  description: 'Create a new menu item in a category through the Add item dialog.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: Create,
  examples: ['add Shawarma Bowl to entrees for $16.99', 'new item Mango Lassi $4.99 in sides', 'add a Kids Quesadilla to kids meal, 8.99'],
  precheck: (i, s) => {
    findCategory(s, i.category)
    if (s.items.some((x) => x.name.toLowerCase() === i.name.toLowerCase())) throw new SkillError(`${i.name} is already on the menu.`)
  },
  async run({ session, before }, i) {
    const cat = findCategory(before, i.category)
    const ov = new MenuOverview(session)
    await ov.open()
    await ov.openAdd('Add item')
    const dlg = dialog(session.page, 'Add item')
    await fill(textField(dlg, 'Name'), i.name)
    await fill(textField(dlg, 'Price'), i.price.toFixed(2))
    await selectField(dlg, 'Category').selectOption(cat.id)
    if (i.unit) await selectField(dlg, 'Unit of Measure').selectOption({ label: i.unit })
    if (i.description) await fill(textField(dlg, 'Description (optional)'), i.description)
    await dialogButton(dlg, 'Add item').click()
    await waitToast(session.page, new RegExp(`${i.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} added`, 'i'))
    return { summary: `Added ${i.name} (${money(i.price)}) to ${cat.name}`, touched: 1, data: { categoryId: cat.id } }
  },
  verify: ({ after, output }, i) => {
    const it = after.items.find((x) => x.name === i.name)
    return verdict([check('exists', true, !!it), check('price', i.price, it?.price, near(i.price, it?.price ?? -1)), check('category', (output.data as { categoryId: string }).categoryId, it?.categoryId), check('status', 'available', it?.status)])
  },
  inverse: (i) => [{ skill: 'menu.item.delete', input: { item: i.name } }],
})

/* 7 ─────────────────────────────── delete */
const Delete = z.object({ item: z.string() })
export const deleteItem = def<z.infer<typeof Delete>>({
  id: 'menu.item.delete', title: 'Delete an item',
  description: 'Permanently delete an item from the menu and all providers. Prefer hiding unless the owner says delete.',
  domain: 'menu', risk: 'destructive', minRole: 'owner', input: Delete,
  examples: ['delete the salmon burger', 'permanently remove hawaiian burger'],
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    await panel.more('Delete item')
    await dialogButton(dialog(session.page, 'Delete item?'), 'Delete').click()
    await waitToast(session.page, new RegExp('deleted', 'i'))
    return { summary: `Deleted ${it.name}`, touched: 1, data: { item: it } }
  },
  verify: ({ after, output }) => { const it = (output.data as { item: Item }).item; return verdict([check(`${it.name} removed`, false, after.items.some((x) => x.id === it.id))]) },
  inverse: (_i, before, out) => {
    const it = (out.data as { item: Item }).item
    const cat = before.categories.find((c) => c.id === it.categoryId)
    return cat ? [{ skill: 'menu.item.create', input: { name: it.name, price: it.price, category: cat.name, description: it.description || undefined, unit: it.unit } }] : null
  },
})

/* 8 ─────────────────────────────── duplicate */
const Dup = z.object({ item: z.string(), newName: z.string().max(120).optional() })
export const duplicateItem = def<z.infer<typeof Dup>>({
  id: 'menu.item.duplicate', title: 'Duplicate an item',
  description: 'Clone an item (price, modifiers, sizes, photo) via the item ⋮ menu, optionally renaming the copy.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: Dup,
  examples: ['duplicate the gyro wrap as Spicy Gyro Wrap', 'copy flame burger'],
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    await panel.more('Duplicate')
    await waitToast(session.page, /Duplicated/i)
    const fresh = await session.waitForTruth((s) => s.items.length > before.items.length)
    const copy = fresh.items.find((x) => !before.items.some((b) => b.id === x.id))
    if (!copy) throw new SkillError('The copy did not appear.')
    let name = copy.name
    if (i.newName) {
      await panel.open(copy.id, copy.name)
      await panel.set('Name', i.newName)
      await panel.save(i.newName)
      name = i.newName
    }
    return { summary: `Duplicated ${it.name} → ${name}`, touched: 1, data: { id: copy.id, name, sourcePrice: it.price } }
  },
  verify: ({ after, output }) => {
    const d = output.data as { id: string; name: string; sourcePrice: number }
    const c = after.items.find((x) => x.id === d.id)
    return verdict([check('copy exists', d.name, c?.name), check('price carried over', d.sourcePrice, c?.price)])
  },
  inverse: (_i, _b, out) => [{ skill: 'menu.item.delete', input: { item: (out.data as { id: string }).id } }],
})

/* 9 ─────────────────────────────── inventory */
const Inv = z.object({ item: z.string(), stock: z.number().int().optional(), adjust: z.number().int().optional().describe('Add/remove units'), track: z.boolean().optional() })
export const setInventory = def<z.infer<typeof Inv>>({
  id: 'menu.item.set_inventory', title: 'Stock count / inventory tracking',
  description: 'Set or adjust an item stock count, or turn inventory tracking on/off.',
  domain: 'menu', risk: 'write', minRole: 'staff', input: Inv,
  examples: ['we have 12 lamb chops left', 'set dolma stock to 40', 'add 20 to wings stock', 'stop tracking inventory on fries'],
  precheck: (i) => { if (i.stock === undefined && i.adjust === undefined && i.track === undefined) throw new SkillError('What should the stock be?') },
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const track = i.track ?? (i.stock !== undefined || i.adjust !== undefined ? true : it.trackInventory)
    const stock = i.stock ?? (i.adjust !== undefined ? it.stock + i.adjust : it.stock)
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    await panel.setTrackInventory(track)
    if (track) await panel.set('Stock Quantity', String(stock))
    await panel.save(it.name)
    return {
      summary: track ? `${it.name} stock: ${it.trackInventory ? it.stock : 'untracked'} → ${stock}` : `Stopped tracking inventory for ${it.name}`,
      touched: 1, data: { id: it.id, track, stock },
    }
  },
  verify: ({ after, output }) => {
    const d = output.data as { id: string; track: boolean; stock: number }
    const it = after.items.find((x) => x.id === d.id)
    return verdict([check('trackInventory', d.track, it?.trackInventory), ...(d.track ? [check('stock', d.stock, it?.stock)] : [])])
  },
  inverse: (i, before) => { const it = findItem(before, i.item); return [{ skill: 'menu.item.set_inventory', input: { item: it.name, stock: it.stock, track: it.trackInventory } }] },
})

/* 10 ─────────────────────────────── modifier groups on an item */
const Mods = z.object({ item: z.string(), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() })
export const setItemModifiers = def<z.infer<typeof Mods>>({
  id: 'menu.item.set_modifiers', title: 'Attach / detach modifier groups',
  description: 'Attach or detach modifier groups (sauces, add-ons, make-it-a-meal) on an item.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: Mods,
  examples: ['add extras to the flame burger', 'remove make it a meal from the veggie burger', 'put wing sauce on the chicken tenders'],
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const add = (i.add ?? []).map((g) => findGroup(before, g)), remove = (i.remove ?? []).map((g) => findGroup(before, g))
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    for (const g of add) await panel.setModifier(g.name, true)
    for (const g of remove) await panel.setModifier(g.name, false)
    const want = [...new Set([...it.modifierGroupIds.filter((x) => !remove.some((r) => r.id === x)), ...add.map((g) => g.id)])]
    if (want.slice().sort().join() === it.modifierGroupIds.slice().sort().join()) return { summary: `${it.name} already had those modifiers`, touched: 0, data: { id: it.id, want } }
    await panel.save(it.name)
    const parts = [add.length ? `+${list(add.map((g) => g.name))}` : '', remove.length ? `−${list(remove.map((g) => g.name))}` : ''].filter(Boolean)
    return { summary: `${it.name} modifiers ${parts.join(', ')}`, touched: 1, data: { id: it.id, want } }
  },
  verify: ({ after, output }) => {
    const d = output.data as { id: string; want: string[] }
    return verdict([check('modifierGroupIds', d.want.slice().sort(), (after.items.find((x) => x.id === d.id)?.modifierGroupIds ?? []).slice().sort())])
  },
  inverse: (i) => [{ skill: 'menu.item.set_modifiers', input: { item: i.item, add: i.remove, remove: i.add } }],
})

/* 11 ─────────────────────────────── sizes */
const Size = z.object({ item: z.string(), size: z.string().min(1).max(60), price: z.number().min(0).optional(), remove: z.boolean().optional() })
export const setSize = def<z.infer<typeof Size>>({
  id: 'menu.item.set_size', title: 'Add / reprice / remove a size',
  description: 'Add a size variant to an item, change a size price, or remove a size.',
  domain: 'menu', risk: 'write', minRole: 'manager', input: Size,
  examples: ['add a large size to fries for $5.99', 'basket of curly fries is now 9.49', 'remove the basket size from fries'],
  precheck: (i, s) => {
    const it = findItem(s, i.item)
    const has = it.sizes.some((z) => z.name.toLowerCase() === i.size.toLowerCase())
    if (i.remove && !has) throw new SkillError(`${it.name} has no "${i.size}" size.`)
    if (!i.remove && i.price === undefined) throw new SkillError(`What should the ${i.size} size cost?`)
  },
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    const row = await panel.findSizeRow(i.size)
    if (i.remove) await row!.locator('button[aria-label="Remove size"]').click()
    else if (row) await fill(textField(row, 'Price'), i.price!.toFixed(2))
    else await panel.addSize(i.size, i.price!.toFixed(2))
    await panel.save(it.name)
    const verb = i.remove ? `removed ${i.size} size` : row ? `${i.size} size → ${money(i.price!)}` : `added ${i.size} size at ${money(i.price!)}`
    return { summary: `${it.name}: ${verb}`, touched: 1, data: { id: it.id } }
  },
  verify: ({ after, output }, i) => {
    const s = after.items.find((x) => x.id === (output.data as { id: string }).id)?.sizes.find((z) => z.name.toLowerCase() === i.size.toLowerCase())
    return verdict(i.remove ? [check(`${i.size} removed`, false, !!s)] : [check(`${i.size} price`, i.price, s?.price, near(i.price!, s?.price ?? -1))])
  },
  inverse: (i, before) => {
    const old = findItem(before, i.item).sizes.find((z) => z.name.toLowerCase() === i.size.toLowerCase())
    return [old ? { skill: 'menu.item.set_size', input: { item: i.item, size: old.name, price: old.price } } : { skill: 'menu.item.set_size', input: { item: i.item, size: i.size, remove: true } }]
  },
})

/* 12 ─────────────────────────────── per-item tax */
const Tax = z.object({ item: z.string(), rate: z.number().min(0).max(30).nullable().describe('Percent; null = use store rate') })
export const setTax = def<z.infer<typeof Tax>>({
  id: 'menu.item.set_tax', title: 'Per-item tax rate',
  description: 'Override the tax rate for an item, or clear it to fall back to the store rate.',
  domain: 'menu', risk: 'write', minRole: 'owner', input: Tax,
  examples: ['set tax on wings to 9.5%', 'clear the tax override on fries'],
  alreadyDone: (i, s) => (findItem(s, i.item).tax === (i.rate === null ? '' : String(i.rate)) ? 'That tax rate is already set.' : null),
  async run({ session, before }, i) {
    const it = findItem(before, i.item)
    const panel = new ItemPanel(session)
    await panel.open(it.id, it.name)
    await panel.set('Tax', i.rate === null ? '' : String(i.rate))
    await panel.save(it.name)
    return { summary: i.rate === null ? `${it.name} now uses the store tax rate` : `${it.name} tax set to ${i.rate}%`, touched: 1, data: { id: it.id } }
  },
  verify: ({ after, output }, i) => verdict([check('tax', i.rate === null ? '' : String(i.rate), after.items.find((x) => x.id === (output.data as { id: string }).id)?.tax)]),
  inverse: (i, before) => { const t = findItem(before, i.item).tax; return [{ skill: 'menu.item.set_tax', input: { item: i.item, rate: t ? Number(t) : null } }] },
})

export const menuItemSkills: Skill[] = [setAvailability, setPrice, adjustPrices, renameItem, setDescription, createItem, deleteItem, duplicateItem, setInventory, setItemModifiers, setSize, setTax]
