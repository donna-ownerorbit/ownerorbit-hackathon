import { rmSync } from 'node:fs'
import { OwnerOrbit } from '../src/core/orbit.ts'
import { SandboxSession } from '../src/browser/session.ts'

/**
 * Every skill, end to end, through the same pipeline iMessage uses — against the real deployed
 * dashboard. Runs isolated (API stubbed, throwaway profile) so the production database is untouched.
 *   npm run e2e            headless
 *   npm run e2e -- --stage watch it
 *   npm run e2e -- --live  against the real DB (careful)
 */
const live = process.argv.includes('--live')
const stage = process.argv.includes('--stage')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
rmSync('.data/e2e-profile', { recursive: true, force: true })
const orbit = new OwnerOrbit(new SandboxSession({ api: live ? 'live' : 'isolated', profileDir: '.data/e2e-profile', stage }))

type Expect = { skill?: string; reply?: RegExp; outcome?: string }
const SCRIPT: [string, Expect][] = [
  ['help', { reply: /Donna/ }],
  ['86 the chicken nuggets', { skill: 'menu.item.set_availability', outcome: 'done' }],
  ['is the chicken nuggets available?', { skill: 'menu.lookup', reply: /sold out today/ }],
  ['nuggets are back', { skill: 'menu.item.set_availability', outcome: 'done' }],
  ["we're out of lamb chops and dolma", { skill: 'menu.item.set_availability', outcome: 'done' }],
  ['undo', { reply: /Undid/ }],
  ['86 the chicken', { reply: /Which/ }],
  ['2', { outcome: 'done' }],
  ['hide the kids meal category', { skill: 'menu.category.set_status', outcome: 'done' }],
  ['turn the kids meal category back on', { skill: 'menu.category.set_status', outcome: 'done' }],
  ['change flame burger to $17.49', { skill: 'menu.item.set_price', outcome: 'done' }],
  ['raise all wraps 5%', { reply: /YES/ }],
  ['yes', { skill: 'menu.items.adjust_prices', outcome: 'done' }],
  ['rename onion rings to Beer Battered Onion Rings', { skill: 'menu.item.rename', outcome: 'done' }],
  ['write a description for the fried calamari', { skill: 'menu.item.set_description', outcome: 'done' }],
  ['add Mango Lassi to sides', { reply: /cost/ }],
  ['4.99', { skill: 'menu.item.create', outcome: 'done' }],
  ['duplicate the gyro wrap as Spicy Gyro Wrap', { skill: 'menu.item.duplicate', outcome: 'done' }],
  ['delete the spicy gyro wrap', { reply: /YES/ }],
  ['yes', { skill: 'menu.item.delete', outcome: 'done' }],
  ['we have 12 lamb chops left', { skill: 'menu.item.set_inventory', outcome: 'done' }],
  ['add extras to the flame burger', { skill: 'menu.item.set_modifiers', outcome: 'done' }],
  ['add a large size to fries for $5.99', { skill: 'menu.item.set_size', outcome: 'done' }],
  ['set tax on wings to 9.5%', { skill: 'menu.item.set_tax', outcome: 'done' }],
  ['add a Drinks category', { skill: 'menu.category.create', outcome: 'done' }],
  ['rename the drinks category to Beverages', { skill: 'menu.category.edit', outcome: 'done' }],
  ['move burgers to the top', { skill: 'menu.category.reorder', outcome: 'done' }],
  ['delete the beverages category', { reply: /YES/ }],
  ['yes', { skill: 'menu.category.delete', outcome: 'done' }],
  ['add Ranch for 50 cents to wing sauce', { skill: 'menu.modifier_group.upsert', outcome: 'done' }],
  ['remove buffalo from wing sauce', { skill: 'menu.modifier_group.upsert', outcome: 'done' }],
  ['push the menu', { skill: 'menu.publish', outcome: 'done' }],
  ['pause orders for 30 minutes', { skill: 'store.set_acceptance', outcome: 'done' }],
  ['resume orders', { skill: 'store.set_acceptance', outcome: 'done' }],
  ['switch to fremont', { skill: 'store.switch_location', outcome: 'done' }],
  ['switch to hayward', { skill: 'store.switch_location', outcome: 'done' }],
  ['any new orders?', { skill: 'orders.list_active', reply: /active/ }],
  ['accept all new orders', { skill: 'orders.update_status', outcome: 'done' }],
  ['how are sales today', { skill: 'insights.sales_report', reply: /Today/ }],
  ['how did we do the last 30 days', { skill: 'insights.sales_report', reply: /Last 30 days/ }],
  ['morning brief', { skill: 'insights.daily_brief', reply: /accepting/ }],
  ["what's 86'd right now", { skill: 'menu.lookup' }],
  ['any chargebacks?', { skill: 'chargebacks.list' }],
  ['close on mondays', { skill: 'schedule.set_hours', outcome: 'done' }],
  ['86 the nuggets and pause orders for 15 min', { outcome: 'done' }],
  ['undo', { reply: /Undid/ }],
  ['history', { reply: /·/ }],
]

let pass = 0, fail = 0
const t0 = Date.now()
await orbit.session.start()
console.log(`sandbox ${orbit.session.url} · api=${orbit.session.apiMode} · data=${await orbit.session.mode()}\n`)
// Chargeback disputes need a live order number from the table.
for (const [text, exp] of SCRIPT) {
  if (only && !text.includes(only)) continue
  const out = await orbit.handle({ from: 'e2e', text, trusted: true })
  const r0 = out.results[0]
  const problems: string[] = []
  if (exp.skill && !out.results.some((r) => r.step.skill === exp.skill)) problems.push(`expected ${exp.skill}, got ${out.results.map((r) => r.step.skill).join(',') || 'none'}`)
  if (exp.outcome && !out.results.length) problems.push('no results')
  if (exp.outcome && out.results.some((r) => r.outcome !== exp.outcome && !(exp.outcome === 'done' && r.outcome === 'noop'))) problems.push(`outcome ${out.results.map((r) => r.outcome).join(',')}`)
  if (exp.reply && !exp.reply.test(out.reply)) problems.push(`reply !~ ${exp.reply}`)
  const v = r0?.verification
  const ok = !problems.length
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${text.padEnd(46)} ${String(out.ms).padStart(6)}ms ${v ? `[${v.level} ${v.checks.filter((c) => c.ok).length}/${v.checks.length}]` : ''}`)
  console.log(`   ↳ ${out.reply.replace(/\n/g, '\n     ')}`)
  if (!ok) console.log(`   ✗ ${problems.join('; ')}`)
}
// Dispute the first open chargeback using its real order number.
const list = await orbit.handle({ from: 'e2e', text: 'any chargebacks?', trusted: true })
const order = list.reply.match(/^((?:DD|UE|GH)-\d+[A-Z])/m)?.[1]
if (order) {
  const out = await orbit.handle({ from: 'e2e', text: `dispute ${order}: bag was sealed at pickup and the driver confirmed`, trusted: true })
  const ok = out.results[0]?.outcome === 'done'
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} dispute ${order}${' '.repeat(30)} ${out.ms}ms\n   ↳ ${out.reply}`)
}
console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
await orbit.session.close()
process.exit(fail ? 1 : 0)
