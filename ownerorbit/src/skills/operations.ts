import { z } from 'zod'
import { card, MenuHeader, OrdersScreen, readBars, readStats } from '../browser/pages.ts'
import { closeOverlays, dialog, dialogButton, exact, fill, setSwitch, textField, until, waitToast } from '../browser/ui.ts'
import { SkillError, STATUS_LABEL, STORES, type Order, type OrderStatus, type Skill, type Snapshot } from '../core/types.ts'

import { check, findCategory, findItem, findOrder, findStore, list, money, verdict } from './common.ts'

const def = <I extends Record<string, unknown>>(s: Skill<I>) => s as unknown as Skill
const empty = z.object({}) as unknown as z.ZodType<Record<string, never>>
const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` }
const providerName = (p: string) => ({ website: 'Website', doordash: 'DoorDash', ubereats: 'Uber Eats', grubhub: 'Grubhub' } as Record<string, string>)[p] ?? p

/* 20 ─────────────────────────────── order acceptance */
const Accept = z.object({ mode: z.enum(['accepting', 'pause', 'stop_today']), minutes: z.number().int().min(1).max(600).optional() })
const PAUSES = [15, 30, 60] as const
export const setAcceptance = def<z.infer<typeof Accept>>({
  id: 'store.set_acceptance', title: 'Pause / resume / stop orders',
  description: 'Resume accepting orders, pause all providers for 15/30/60 min, or stop for the rest of today.',
  domain: 'store', risk: 'write', minRole: 'staff', input: Accept,
  examples: ['pause orders for 30 minutes', 'we are slammed, pause for an hour', 'stop taking orders for today', 'resume orders', 'we are back open'],
  confirm: (i) => (i.mode === 'stop_today' ? 'This stops orders on every provider until tomorrow.' : null),
  alreadyDone: (i, s) => (i.mode === 'accepting' && s.restaurant.accepting ? "You're already accepting orders." : null),
  async run({ session }, i) {
    const h = new MenuHeader(session)
    await h.open()
    let note = ''
    if (i.mode === 'accepting') await h.acceptance('Accepting orders')
    else if (i.mode === 'stop_today') await h.acceptance('Stop for today')
    else {
      const want = i.minutes ?? 30
      const m = PAUSES.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a))
      if (m !== want) note = ` (the dashboard offers 15/30/60 — used ${m})`
      await h.acceptance(`Pause for ${m} min` as 'Pause for 15 min')
      return { summary: `Orders paused for ${m} min on all providers${note}`, touched: 1, data: { minutes: m, at: Date.now() } }
    }
    return { summary: i.mode === 'accepting' ? 'Accepting orders again on all providers' : 'Stopped taking orders for the rest of today', touched: 1, data: {} }
  },
  verify: async ({ after, session, output }, i) => {
    const r = after.restaurant
    const checks = [check('accepting', i.mode === 'accepting', r.accepting)]
    if (i.mode === 'pause') {
      const d = output.data as { minutes: number; at: number }
      const exp = d.at + d.minutes * 60000
      checks.push(check('pausedUntil ≈ now + pause', new Date(exp).toLocaleTimeString(), r.pausedUntil ? new Date(r.pausedUntil).toLocaleTimeString() : null, !!r.pausedUntil && Math.abs(r.pausedUntil - exp) < 90_000))
    }
    const h = new MenuHeader(session)
    await h.open()
    const label = await h.acceptanceLabel()
    checks.push(check('header badge', i.mode === 'accepting' ? 'Accepting' : i.mode === 'pause' ? 'Paused · …' : 'Not accepting', label, i.mode === 'accepting' ? label === 'Accepting' : i.mode === 'pause' ? label.startsWith('Paused') : label === 'Not accepting'))
    return verdict(checks)
  },
  inverse: (_i, before) => [{ skill: 'store.set_acceptance', input: before.restaurant.accepting ? { mode: 'accepting' } : { mode: 'stop_today' } }],
})

/* 21 ─────────────────────────────── switch location */
const Loc = z.object({ store: z.string() })
export const switchLocation = def<z.infer<typeof Loc>>({
  id: 'store.switch_location', title: 'Switch location',
  description: 'Switch the dashboard to another Falafel Flare location (Hayward, Fremont, San Leandro).',
  domain: 'store', risk: 'write', minRole: 'manager', input: Loc,
  examples: ['switch to fremont', 'go to the san leandro store', 'use hayward'],
  alreadyDone: (i, s) => (s.restaurant.storeId === findStore(i.store).id ? `Already on ${findStore(i.store).name}.` : null),
  async run({ session }, i) {
    const st = findStore(i.store)
    const h = new MenuHeader(session)
    await h.open()
    await h.switchStore(st.name)
    return { summary: `Switched to ${st.name}`, touched: 1, data: { id: st.id } }
  },
  verify: ({ after, output }) => verdict([check('storeId', (output.data as { id: string }).id, after.restaurant.storeId)]),
  inverse: (_i, before) => [{ skill: 'store.switch_location', input: { store: before.restaurant.storeId } }],
})

/* 22 ─────────────────────────────── list active orders */
const ACTIVE: OrderStatus[] = ['new', 'preparing', 'ready']
export const listOrders = def<Record<string, never>>({
  id: 'orders.list_active', title: 'Live order queue',
  description: 'Read the live order queue (new, preparing, ready) across every provider.',
  domain: 'orders', risk: 'read', minRole: 'staff', input: empty,
  examples: ['any new orders?', 'what orders are open', "what's in the queue", 'show me active orders'],
  async run({ before }) {
    const active = before.orders.filter((o) => ACTIVE.includes(o.status)).sort((a, b) => a.placedAt - b.placedAt)
    if (!active.length) return { summary: 'No active orders right now.', touched: 0 }
    const line = (o: Order) => `${o.number} · ${o.status.toUpperCase()} · ${providerName(o.provider)} · ${o.customer} · ${o.lines.reduce((s, l) => s + l.qty, 0)} items · ${money(o.total)} · ${ago(o.placedAt)} ago`
    const counts = ACTIVE.map((s) => `${active.filter((o) => o.status === s).length} ${s}`).join(', ')
    return { summary: `${active.length} active (${counts}):\n` + active.map(line).join('\n'), touched: 0, data: { ids: active.map((o) => o.id) } }
  },
})

/* 23 ─────────────────────────────── advance / reject orders */
const Adv = z.object({
  orders: z.array(z.string()).optional().describe('Order numbers, e.g. "#8243" or "DD-8240D"'),
  scope: z.enum(['all_new', 'all_preparing', 'all_ready']).optional(),
  to: z.enum(['preparing', 'ready', 'completed', 'canceled']).describe('accept → preparing; reject → canceled'),
})
const FLOW: OrderStatus[] = ['new', 'preparing', 'ready', 'completed']
const BUTTON: Record<string, 'Accept & prepare' | 'Mark ready' | 'Complete'> = { new: 'Accept & prepare', preparing: 'Mark ready', ready: 'Complete' }
function targets(s: Snapshot, i: z.infer<typeof Adv>) {
  if (i.scope) return s.orders.filter((o) => o.status === i.scope!.replace('all_', ''))
  if (!i.orders?.length) throw new SkillError('Which order? Give me the order number.')
  return i.orders.map((r) => findOrder(s, r))
}
export const updateOrder = def<z.infer<typeof Adv>>({
  id: 'orders.update_status', title: 'Accept / ready / complete / reject orders',
  description: 'Move orders through the kitchen flow (accept → ready → complete) or reject a new order, using the ticket buttons.',
  domain: 'orders', risk: 'write', minRole: 'staff', input: Adv,
  examples: ['accept order 8243', 'mark #8241 ready', 'complete DD-8240D', 'reject 8242', 'accept all new orders', 'everything ready is picked up'],
  precheck: (i, s) => {
    const list = targets(s, i)
    if (!list.length) throw new SkillError('There are no orders in that state.')
    for (const o of list) {
      if (i.to === 'canceled' && o.status !== 'new') throw new SkillError(`${o.number} is ${o.status}; only new orders can be rejected.`)
      if (i.to !== 'canceled' && (o.status === 'canceled' || FLOW.indexOf(o.status) > FLOW.indexOf(i.to))) throw new SkillError(`${o.number} is already ${o.status}.`)
    }
  },
  confirm: (i, s) => (i.to === 'canceled' ? `Reject ${list(targets(s, i).map((o) => o.number))}? The customer gets refunded.` : null),
  alreadyDone: (i, s) => (targets(s, i).every((o) => o.status === i.to) ? `${list(targets(s, i).map((o) => o.number))} already ${i.to}.` : null),
  async run({ session, before }, i) {
    const scr = new OrdersScreen(session)
    const done: { id: string; number: string; from: OrderStatus }[] = []
    for (const o of targets(before, i)) {
      if (o.status === i.to) continue
      await scr.openTicket(o.id, o.number)
      if (i.to === 'canceled') await scr.press('Reject')
      else for (let st = o.status; st !== i.to; st = FLOW[FLOW.indexOf(st) + 1]) await scr.press(BUTTON[st])
      done.push({ id: o.id, number: o.number, from: o.status })
    }
    const verb = { preparing: 'accepted', ready: 'marked ready', completed: 'completed', canceled: 'rejected' }[i.to]
    return { summary: `${list(done.map((d) => d.number))} ${verb}`, touched: done.length, data: { done } }
  },
  verify: ({ after, output }, i) => verdict((output.data as { done: { id: string; number: string }[] }).done.map((d) => check(`${d.number}.status`, i.to, after.orders.find((o) => o.id === d.id)?.status))),
})

/* 24 ─────────────────────────────── menu lookup (read) */
const Lookup = z.object({
  items: z.array(z.string()).optional(), category: z.string().optional(),
  filter: z.enum(['unavailable', 'available', 'hidden', 'new', 'low_stock', 'no_photo', 'all']).optional(),
})
export const lookupMenu = def<z.infer<typeof Lookup>>({
  id: 'menu.lookup', title: 'Ask about the menu',
  description: 'Answer questions about the live menu: is X available, what does X cost, what is sold out, what is in a category, low stock.',
  domain: 'menu', risk: 'read', minRole: 'staff', input: Lookup,
  examples: ['is the flame burger available?', "what's 86'd right now", 'how much are the wings', "what's in kids meal", 'what is low on stock', 'which items have no photo'],
  async run({ before: s }, i) {
    const label = (st: keyof typeof STATUS_LABEL) => STATUS_LABEL[st].toLowerCase()
    if (i.items?.length) {
      return {
        summary: i.items.map((r) => {
          const it = findItem(s, r)
          const sizes = it.sizes.length ? ` (${it.sizes.map((z) => `${z.name} ${money(z.price)}`).join(', ')})` : ''
          const stock = it.trackInventory ? ` · ${it.stock} in stock` : ''
          return `${it.name}: ${label(it.status)} · ${money(it.price)}${sizes}${stock}`
        }).join('\n'), touched: 0,
      }
    }
    let pool = i.category ? s.items.filter((x) => x.categoryId === findCategory(s, i.category!).id) : s.items
    const f = i.filter ?? (i.category ? 'all' : 'unavailable')
    if (f === 'unavailable') pool = pool.filter((x) => x.status !== 'available')
    if (f === 'available') pool = pool.filter((x) => x.status === 'available')
    if (f === 'hidden') pool = pool.filter((x) => x.status === 'hidden')
    if (f === 'new') pool = pool.filter((x) => x.isNew)
    if (f === 'low_stock') pool = pool.filter((x) => x.trackInventory && x.stock < 20).sort((a, b) => a.stock - b.stock)
    if (f === 'no_photo') pool = pool.filter((x) => !x.image)
    const head = { unavailable: 'Unavailable', available: 'Available', hidden: 'Hidden', new: 'New', low_stock: 'Low stock', no_photo: 'No photo', all: i.category ? findCategory(s, i.category).name : 'Menu' }[f]
    if (!pool.length) return { summary: f === 'unavailable' ? 'Everything is available right now.' : `${head}: nothing.`, touched: 0 }
    const row = (x: (typeof pool)[number]) => f === 'low_stock' ? `${x.name} — ${x.stock} left` : f === 'unavailable' ? `${x.name} — ${label(x.status)}` : `${x.name} ${money(x.price)}${x.status !== 'available' ? ` (${label(x.status)})` : ''}`
    return { summary: `${head} (${pool.length}):\n` + pool.slice(0, 25).map(row).join('\n') + (pool.length > 25 ? `\n…+${pool.length - 25} more` : ''), touched: 0 }
  },
})

/* 25 ─────────────────────────────── sales report (reads the Reports screen) */
const Report = z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(14), z.literal(30)]).default(7) })
export const salesReport = def<z.infer<typeof Report>>({
  id: 'insights.sales_report', title: 'Sales report',
  description: 'Read sales, order count, average ticket, commission, category and channel mix from the Reports screen (today, 7, 14 or 30 days), plus top sellers.',
  domain: 'insights', risk: 'read', minRole: 'manager', input: Report,
  examples: ['how are sales today', 'sales this week', 'how did we do the last 30 days', 'top sellers', 'what is our average ticket'],
  async run({ session, before }, i) {
    const page = session.page
    await closeOverlays(page)
    if (i.days === 1) {
      await session.go('/home')
      await page.locator('.stat').first().waitFor()
      const st = await readStats(page)
      return { summary: `Today: ${st["Today's sales"]} across ${st['Orders today']} orders (avg ${st['Avg. ticket']}). ${st['Active orders']} active right now.`, touched: 0, data: st }
    }
    await session.go('/reports')
    await page.locator('.page-header .seg button').filter({ hasText: exact(`${i.days}D`) }).click()
    await until(async () => ((await page.locator('.page-header .seg button.on').textContent()) ?? '') === `${i.days}D`, 'range toggle')
    const st = await readStats(page)
    const cats = (await readBars(card(page, 'Sales by category').locator('.hbars'))).slice(0, 3)
    const chans = await readBars(card(page, 'Channel mix').locator('.hbars'))
    const top = [...before.items].sort((a, b) => b.orders30d - a.orders30d).slice(0, 3).map((x) => `${x.name} (${x.orders30d})`)
    return {
      summary: [
        `Last ${i.days} days: ${st['Gross sales']} gross · ${st['Orders']} orders · avg ${st['Avg. ticket']} · est. commission ${st['Est. commission']}`,
        `Top categories: ${cats.map((c) => `${c.label} ${c.value}`).join(', ')}`,
        `Channels: ${chans.map((c) => `${c.label.replace('Online Ordering ', '')} ${c.value}`).join(', ')}`,
        `Best sellers (30d): ${top.join(', ')}`,
      ].join('\n'), touched: 0, data: { st, cats, chans },
    }
  },
})

/* 26 ─────────────────────────────── daily brief (home) */
export const dailyBrief = def<Record<string, never>>({
  id: 'insights.daily_brief', title: 'Daily brief',
  description: 'One-text status: sales today, live queue, acceptance, what is 86d, negative stock and open chargebacks.',
  domain: 'insights', risk: 'read', minRole: 'staff', input: empty,
  examples: ['morning brief', 'how are we doing', 'status', 'what needs my attention'],
  async run({ session, before: s }) {
    const page = session.page
    await closeOverlays(page)
    await session.go('/home')
    await page.locator('.stat').first().waitFor()
    const st = await readStats(page)
    const attention = (await card(page, 'Needs attention').locator('li').allTextContents()).map((t) => t.trim())
    const out = s.items.filter((x) => x.status !== 'available')
    const store = STORES.find((x) => x.id === s.restaurant.storeId)?.name ?? s.restaurant.storeId
    const acc = s.restaurant.accepting ? 'accepting orders' : s.restaurant.pausedUntil ? `PAUSED until ${new Date(s.restaurant.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'NOT accepting orders'
    return {
      summary: [
        `${store} · ${acc}`,
        `Today ${st["Today's sales"]} · ${st['Orders today']} orders · ${st['Active orders']} in the queue`,
        out.length ? `86'd: ${list(out.map((x) => x.name), 5)}` : 'Full menu available',
        ...attention.filter((a) => !/unavailable on your menu/.test(a)).slice(0, 3).map((a) => `• ${a}`),
      ].join('\n'), touched: 0, data: { st, attention },
    }
  },
})

/* 27 ─────────────────────────────── chargebacks (list) */
async function readChargebacks(session: Parameters<Skill['run']>[0]['session']) {
  const page = session.page
  await closeOverlays(page)
  await session.go('/chargeback')
  await page.locator('.data-table').waitFor()
  const rows = []
  for (const tr of await page.locator('.data-table tbody tr').all()) {
    const tds = (await tr.locator('td').allTextContents()).map((t) => t.trim())
    const provider = ['DoorDash', 'Uber Eats', 'Grubhub', 'Online Ordering Website'].find((p) => tds[1].endsWith(p)) ?? tds[1]
    rows.push({ order: tds[0], provider, date: tds[2], reason: tds[3], amount: tds[4], status: tds[5] })
  }
  return rows
}
export const listChargebacks = def<Record<string, never>>({
  id: 'chargebacks.list', title: 'Open chargebacks',
  description: 'List open chargebacks (order, provider, reason, amount) that can still be disputed.',
  domain: 'chargebacks', risk: 'read', minRole: 'manager', input: empty,
  examples: ['any chargebacks?', 'what chargebacks are open', 'show disputes'],
  async run({ session }) {
    const rows = await readChargebacks(session)
    const open = rows.filter((r) => r.status === 'Open')
    if (!open.length) return { summary: 'No open chargebacks. 🎉', touched: 0 }
    return { summary: `${open.length} open chargeback${open.length > 1 ? 's' : ''}:\n` + open.map((r) => `${r.order} · ${r.provider} · ${r.reason} · ${r.amount}`).join('\n') + '\nReply e.g. "dispute ' + open[0].order + ': bag was sealed at pickup"', touched: 0, data: rows }
  },
})

/* 28 ─────────────────────────────── chargebacks (dispute) */
const Dispute = z.object({ order: z.string(), note: z.string().min(10).max(1000) })
export const disputeChargeback = def<z.infer<typeof Dispute>>({
  id: 'chargebacks.dispute', sessionOnly: true, title: 'Dispute a chargeback',
  description: 'File a dispute on an open chargeback with the owner\'s explanation.',
  domain: 'chargebacks', risk: 'write', minRole: 'manager', input: Dispute,
  examples: ['dispute DD-8235X: order was picked up sealed and complete', 'fight the chargeback on 8212 — driver confirmed delivery'],
  async run({ session }, i) {
    const page = session.page
    const rows = await readChargebacks(session)
    const digits = i.order.replace(/\D/g, '')
    const row = rows.find((r) => r.order.toLowerCase() === i.order.toLowerCase()) ?? rows.find((r) => digits && r.order.replace(/\D/g, '') === digits)
    if (!row) throw new SkillError(`No chargeback on ${i.order}. Open ones: ${rows.filter((r) => r.status === 'Open').map((r) => r.order).join(', ') || 'none'}.`)
    if (row.status !== 'Open') throw new SkillError(`${row.order} is already ${row.status.toLowerCase()}.`)
    await page.locator('.data-table tbody tr').filter({ has: page.locator('.strong-cell', { hasText: exact(row.order) }) }).locator('button', { hasText: 'Dispute' }).click()
    const dlg = dialog(page, `Dispute ${row.order}`)
    await fill(textField(dlg, 'What happened?'), i.note)
    await dialogButton(dlg, 'Submit dispute').click()
    const toast = await waitToast(page, /Dispute submitted/i)
    return { summary: `${toast} for ${row.order} (${row.amount}, “${row.reason}”)`, touched: 1, data: { order: row.order } }
  },
  // Sandbox keeps dispute status in component state only, so we verify on-screen without a reload.
  verify: async ({ session, output }) => {
    const page = session.page
    const o = (output.data as { order: string }).order
    const pill = page.locator('.data-table tbody tr').filter({ has: page.locator('.strong-cell', { hasText: exact(o) }) }).locator('.status-pill')
    return verdict([check(`${o} status`, 'Disputed', ((await pill.textContent()) ?? '').trim())], 'session')
  },
})

/* 29 ─────────────────────────────── business hours */
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const Hours = z.object({
  days: z.array(z.enum(DAYS)).min(1),
  open: z.boolean().optional(),
  from: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('24h HH:MM'),
  to: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('24h HH:MM'),
})
export const setHours = def<z.infer<typeof Hours>>({
  id: 'schedule.set_hours', sessionOnly: true, title: 'Business hours',
  description: 'Open/close days and set opening hours on the Schedule screen, then push hours to all providers.',
  domain: 'schedule', risk: 'write', minRole: 'owner', input: Hours,
  examples: ['close on mondays', 'open sunday 12 to 9', 'friday and saturday till midnight', 'weekdays 11am to 10pm'],
  precheck: (i) => { if (i.open === undefined && !i.from && !i.to) throw new SkillError('Open or closed, and what hours?') },
  async run({ session }, i) {
    const page = session.page
    await closeOverlays(page)
    await session.go('/schedule')
    await page.locator('.hours').waitFor()
    for (const d of i.days) {
      const row = page.locator('.hours-row').filter({ has: page.locator('b', { hasText: exact(d) }) })
      const open = i.open ?? true
      await setSwitch(row, /Open|Closed/, open)
      if (open) {
        const t = row.locator('input.time')
        if (i.from) await t.nth(0).fill(i.from)
        if (i.to) await t.nth(1).fill(i.to)
      }
    }
    await page.locator('.page-header button').filter({ hasText: 'Save hours' }).click()
    await waitToast(page, /Hours pushed/i)
    const hrs = i.open === false ? 'closed' : `${i.from ?? 'open'}${i.to ? '–' + i.to : ''}`
    return { summary: `${i.days.length === 7 ? 'Every day' : list(i.days.map((d) => d.slice(0, 3)))}: ${hrs} · pushed to all providers`, touched: i.days.length }
  },
  verify: async ({ session }, i) => {
    const page = session.page
    const checks = []
    for (const d of i.days) {
      const row = page.locator('.hours-row').filter({ has: page.locator('b', { hasText: exact(d) }) })
      const open = (await row.locator('[role="switch"]').getAttribute('aria-checked')) === 'true'
      checks.push(check(`${d} open`, i.open ?? true, open))
      if (open && i.from) checks.push(check(`${d} from`, i.from, await row.locator('input.time').nth(0).inputValue()))
      if (open && i.to) checks.push(check(`${d} to`, i.to, await row.locator('input.time').nth(1).inputValue()))
    }
    return verdict(checks, 'session')
  },
})

export const operationsSkills: Skill[] = [setAcceptance, switchLocation, listOrders, updateOrder, lookupMenu, salesReport, dailyBrief, listChargebacks, disputeChargeback, setHours]
