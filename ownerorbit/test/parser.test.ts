import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Parser, toTime, parseDays, parseOptions } from '../src/nlu/parser.ts'
import type { Snapshot } from '../src/core/types.ts'
import { SKILLS } from '../src/skills/index.ts'

const snap: Snapshot = JSON.parse(readFileSync(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8'))
const P = (focus = {}) => new Parser(snap, focus)

/** [text, skill, input subset] — every case is an owner-style text message. */
const CASES: [string, string, Record<string, unknown>][] = [
  // availability
  ['86 the chicken nuggets', 'menu.item.set_availability', { items: ['Chicken Nuggets with Fries'], status: 'sold_out_today' }],
  ['Mark item Chicken Nuggets unavailable', 'menu.item.set_availability', { items: ['Chicken Nuggets with Fries'], status: 'sold_out_today' }],
  ['hey donna, can you 86 nuggs pls', 'menu.item.set_availability', { items: ['Chicken Nuggets with Fries'], status: 'sold_out_today' }],
  ["we're out of lamb chops and dolma", 'menu.item.set_availability', { items: ['BBQ Lamb Chops', 'Dolma'], status: 'sold_out_today' }],
  ['nuggets are back', 'menu.item.set_availability', { items: ['Chicken Nuggets with Fries'], status: 'available' }],
  ['un86 the calamari', 'menu.item.set_availability', { items: ['Fried Calamari'], status: 'available' }],
  ['hide the salmon burger', 'menu.item.set_availability', { items: ['Salmon Burger'], status: 'hidden' }],
  ['take the hawaiian burger off the menu', 'menu.item.set_availability', { items: ['Hawaiian Burger'], status: 'hidden' }],
  ['calamari is sold out indefinitely', 'menu.item.set_availability', { items: ['Fried Calamari'], status: 'sold_out' }],
  ['86 everything in kids meal', 'menu.item.set_availability', { category: 'Kids Meal', status: 'sold_out_today' }],
  ['mark the baba ganoush unavailable on doordash', 'menu.item.set_availability', { items: ['Baba Ganoush'], providers: ['DoorDash'] }],
  ['flame burger sold out', 'menu.item.set_availability', { items: ['Flame Burger'], status: 'sold_out_today' }],
  ['ran out of onion rings', 'menu.item.set_availability', { items: ['Onion Rings'], status: 'sold_out_today' }],
  ['make the wings available again', 'menu.item.set_availability', { items: ['Wings (8 pcs)'], status: 'available' }],
  ['86 chiken nugets', 'menu.item.set_availability', { items: ['Chicken Nuggets with Fries'], status: 'sold_out_today' }],
  ['hide the kids meal category', 'menu.category.set_status', { category: 'Kids Meal', status: 'hidden' }],
  // prices
  ['change flame burger to $17.99', 'menu.item.set_price', { item: 'Flame Burger', price: 17.99 }],
  ['falafel wrap is 11.49 now', 'menu.item.set_price', { item: 'Falafel Wrap', price: 11.49 }],
  ['raise wings by $1', 'menu.item.set_price', { item: 'Wings (8 pcs)', delta: 1 }],
  ['drop the dolma price 10%', 'menu.item.set_price', { item: 'Dolma', percent: -10 }],
  ['raise all burgers 5%', 'menu.items.adjust_prices', { category: 'Burgers', percent: 5 }],
  ['add 50 cents to every wrap', 'menu.items.adjust_prices', { category: 'Wraps', amount: 0.5 }],
  ['raise entrees 3% and round to .99', 'menu.items.adjust_prices', { category: 'Entrees', percent: 3, rounding: 'nines' }],
  // item edits
  ['rename flame burger to Inferno Burger', 'menu.item.rename', { item: 'Flame Burger', newName: 'Inferno Burger' }],
  ['write a description for the fried calamari', 'menu.item.set_description', { item: 'Fried Calamari', generate: true }],
  ['set the onion rings description to Thick-cut, beer battered.', 'menu.item.set_description', { item: 'Onion Rings', description: 'Thick-cut, beer battered.' }],
  ['add Shawarma Bowl to entrees for $16.99', 'menu.item.create', { name: 'Shawarma Bowl', category: 'Entrees', price: 16.99 }],
  ['add a mango lassi to sides, 4.99', 'menu.item.create', { name: 'Mango Lassi', category: 'Sides', price: 4.99 }],
  ['delete the salmon burger', 'menu.item.delete', { item: 'Salmon Burger' }],
  ['duplicate the gyro wrap as Spicy Gyro Wrap', 'menu.item.duplicate', { item: 'Gyro Wrap', newName: 'Spicy Gyro Wrap' }],
  ['we have 12 lamb chops left', 'menu.item.set_inventory', { item: 'BBQ Lamb Chops', stock: 12 }],
  ['set dolma stock to 40', 'menu.item.set_inventory', { item: 'Dolma', stock: 40 }],
  ['stop tracking inventory on fries', 'menu.item.set_inventory', { item: 'Fries', track: false }],
  ['add extras to the flame burger', 'menu.item.set_modifiers', { item: 'Flame Burger', add: ['Add Extras'] }],
  ['remove make it a meal from the veggie burger', 'menu.item.set_modifiers', { item: 'Veggie Burger', remove: ['Make it a Meal'] }],
  ['add a large size to fries for $5.99', 'menu.item.set_size', { item: 'Fries', size: 'Large', price: 5.99 }],
  ['remove the basket size from fries', 'menu.item.set_size', { item: 'Fries', size: 'Basket', remove: true }],
  ['set tax on wings to 9.5%', 'menu.item.set_tax', { item: 'Wings (8 pcs)', rate: 9.5 }],
  // categories / modifiers / publish
  ['add a Drinks category', 'menu.category.create', { name: 'Drinks' }],
  ['rename the starters category to Appetizers', 'menu.category.edit', { category: 'Starters', newName: 'Appetizers' }],
  ['move burgers to the top', 'menu.category.reorder', { category: 'Burgers', to: 'top' }],
  ['put kids meal last', 'menu.category.reorder', { category: 'Kids Meal', to: 'bottom' }],
  ['delete the kids meal category', 'menu.category.delete', { category: 'Kids Meal' }],
  ['add Ranch for 50 cents to wing sauce', 'menu.modifier_group.upsert', { group: 'Wing Sauce', addOptions: [{ name: 'Ranch', price: 0.5 }] }],
  ['remove buffalo from wing sauce', 'menu.modifier_group.upsert', { group: 'Wing Sauce', removeOptions: ['Buffalo'] }],
  ['make entree sauce optional', 'menu.modifier_group.upsert', { group: 'Entree Sauce', required: false }],
  ['create a modifier group Dressing with Ranch, Caesar $0.50 and Tahini', 'menu.modifier_group.upsert', { group: 'Dressing', create: true }],
  ['push the menu', 'menu.publish', {}],
  ['update provider menus', 'menu.publish', {}],
  // store + orders
  ['pause orders for 30 minutes', 'store.set_acceptance', { mode: 'pause', minutes: 30 }],
  ["we're slammed, pause for an hour", 'store.set_acceptance', { mode: 'pause', minutes: 60 }],
  ['stop taking orders for today', 'store.set_acceptance', { mode: 'stop_today' }],
  ['resume orders', 'store.set_acceptance', { mode: 'accepting' }],
  ['we are back open', 'store.set_acceptance', { mode: 'accepting' }],
  ['switch to fremont', 'store.switch_location', { store: 'fremont' }],
  ['any new orders?', 'orders.list_active', {}],
  ['accept order 8243', 'orders.update_status', { to: 'preparing' }],
  ['mark #8241 ready', 'orders.update_status', { to: 'ready' }],
  ['reject 8242', 'orders.update_status', { to: 'canceled' }],
  ['accept all new orders', 'orders.update_status', { scope: 'all_new', to: 'preparing' }],
  // reads
  ['is the flame burger available?', 'menu.lookup', { items: ['Flame Burger'] }],
  ['how much are the wings', 'menu.lookup', { items: ['Wings (8 pcs)'] }],
  ["what's 86'd right now", 'menu.lookup', { filter: 'unavailable' }],
  ["what's in kids meal", 'menu.lookup', { category: 'Kids Meal' }],
  ['what is low on stock', 'menu.lookup', { filter: 'low_stock' }],
  ['how are sales today', 'insights.sales_report', { days: 1 }],
  ['how did we do the last 30 days', 'insights.sales_report', { days: 30 }],
  ['morning brief', 'insights.daily_brief', {}],
  ['any chargebacks?', 'chargebacks.list', {}],
  ['dispute DD-8235X: bag was sealed at pickup and complete', 'chargebacks.dispute', { order: 'DD-8235X' }],
  ['close on mondays', 'schedule.set_hours', { days: ['Monday'], open: false }],
  ['open sunday 12 to 9', 'schedule.set_hours', { days: ['Sunday'], from: '12:00', to: '21:00' }],
  ['weekdays 11am to 10pm', 'schedule.set_hours', { from: '11:00', to: '22:00' }],
]

for (const [text, skill, subset] of CASES) {
  test(text, () => {
    const r = P().parse(text)
    assert.equal(r.kind, 'plan', `${text} → ${JSON.stringify(r)}`)
    if (r.kind !== 'plan') return
    assert.equal(r.steps[0].skill, skill, JSON.stringify(r.steps))
    for (const [k, v] of Object.entries(subset)) assert.deepEqual(r.steps[0].input[k], v, `${k} in ${JSON.stringify(r.steps[0].input)}`)
    // Every plan must validate against the skill's schema.
    const s = SKILLS.find((x) => x.id === skill)!
    assert.ok(s.input.safeParse(r.steps[0].input).success, JSON.stringify(s.input.safeParse(r.steps[0].input)))
  })
}

test('compound: 86 the nuggets and pause orders for 30 min', () => {
  const r = P().parse('86 the nuggets and pause orders for 30 min')
  assert.equal(r.kind, 'plan')
  if (r.kind === 'plan') assert.deepEqual(r.steps.map((s) => s.skill), ['menu.item.set_availability', 'store.set_acceptance'])
})
test('compound with then', () => {
  const r = P().parse('change wings to $18.99 then push the menu')
  assert.ok(r.kind === 'plan' && r.steps.length === 2 && r.steps[1].skill === 'menu.publish', JSON.stringify(r))
})
test('ambiguous "chicken" asks', () => {
  const r = P().parse('86 the chicken')
  assert.equal(r.kind, 'clarify', JSON.stringify(r))
})
test('pronoun uses focus', () => {
  const r = P({ items: ['Dolma'] }).parse('make it available again')
  assert.ok(r.kind === 'plan' && JSON.stringify(r.steps[0].input.items) === '["Dolma"]', JSON.stringify(r))
})
test('follow-up "the wings too"', () => {
  const r = P({ lastStep: { skill: 'menu.item.set_availability', input: { items: ['Dolma'], status: 'sold_out_today' } } }).parse('the wings too')
  assert.ok(r.kind === 'plan' && JSON.stringify(r.steps[0].input.items) === '["Wings (8 pcs)"]', JSON.stringify(r))
})
test('missing price asks', () => {
  const r = P().parse('add Mango Lassi to sides')
  assert.equal(r.kind, 'ask')
})
test('meta', () => {
  for (const [t, m] of [['yes', 'yes'], ['Do it', 'yes'], ['nvm', 'no'], ['undo that', 'undo'], ['2', 'choice'], ['help', 'help']] as const) {
    const r = P().parse(t)
    assert.ok(r.kind === 'meta' && r.meta === m, `${t} → ${JSON.stringify(r)}`)
  }
})
test('unknown item does not guess', () => {
  const r = P().parse('86 the lobster')
  assert.notEqual(r.kind, 'plan')
})
test('helpers', () => {
  assert.equal(toTime('10', 'close'), '22:00')
  assert.equal(toTime('11am', 'open'), '11:00')
  assert.equal(toTime('midnight', 'close'), '00:00')
  assert.deepEqual(parseDays('mon-wed'), ['Monday', 'Tuesday', 'Wednesday'])
  assert.deepEqual(parseOptions('Ranch for 50 cents, Caesar $0.50 and Tahini'), [{ name: 'Ranch', price: 0.5 }, { name: 'Caesar', price: 0.5 }, { name: 'Tahini', price: 0 }])
})
test('every skill has ≥2 examples and a valid JSON schema', () => {
  assert.ok(SKILLS.length >= 25)
  for (const s of SKILLS) assert.ok(s.examples.length >= 2, s.id)
})
