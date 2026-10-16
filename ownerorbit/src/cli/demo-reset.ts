import { config } from '../config.ts'
import { C, getDb, normalizeHandle, rid } from '../db/mongo.ts'

/**
 * Put the live demo back to its starting point: Chicken Nuggets available, no catering page,
 * no catering objective/handoffs from the demo number, empty mock phone thread.
 *   npm run demo:reset            (add --keep-page to leave /p/catering up)
 */
const db = await getDb()
const who = normalizeHandle(config.demoPhone)
const site = config.sandboxUrl
const state = (await (await fetch(`${site}/api/state`)).json()) as { items: { id: string; name: string; status: string }[] }
const nug = state.items.find((i) => /chicken nuggets/i.test(i.name))
if (nug && nug.status !== 'available') {
  const r = await fetch(`${site}/api/items/${nug.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'available' }) })
  console.log(`nuggets → available (${r.status})`)
} else console.log('nuggets already available')
const out = {
  page: process.argv.includes('--keep-page') ? 'kept' : (await db.collection('site_pages').deleteMany({ restaurantId: rid(), slug: 'catering' })).deletedCount,
  objectives: (await db.collection(C.objectives).deleteMany({ restaurantId: rid(), createdBy: `agent:${who}` })).deletedCount,
  handoffs: (await db.collection(C.handoffs).deleteMany({ restaurantId: rid(), by: `agent:${who}` })).deletedCount,
  followups: (await db.collection(C.followups).deleteMany({ restaurantId: rid(), principal: who })).deletedCount,
  thread: (await db.collection('mock_imessages').deleteMany({ chat: `mock;-;${config.demoPhone}` })).deletedCount,
  conversation: (await db.collection(C.conversations).deleteMany({ principal: who })).deletedCount,
}
console.log('reset', JSON.stringify(out))
process.exit(0)
