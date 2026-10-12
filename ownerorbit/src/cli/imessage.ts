import { randomUUID } from 'node:crypto'
import { config } from '../config.ts'
import { C, getDb } from '../db/mongo.ts'

/**
 * Fire a real BlueBubbles-shaped webhook at the running server — the exact path an iMessage takes
 * (webhook → inbox → grammar/Haiku → skill → verify → BlueBubbles reply) minus Apple.
 *   npm run imessage -- +15105551234 "mark chicken nuggets out of stock"
 */
const [from, ...words] = process.argv.slice(2)
if (!from || !words.length) throw new Error('usage: npm run imessage -- <phone> <text…>')
const guid = randomUUID()
const url = `http://localhost:${config.port}/messages/inbound${config.bluebubbles.webhookSecret ? `?secret=${config.bluebubbles.webhookSecret}` : ''}`
const r = await fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'new-message', data: { guid, text: words.join(' '), isFromMe: false, handle: { address: from }, chats: [{ guid: `iMessage;-;${from}` }] } }),
})
console.log(`webhook → ${r.status}`)
const db = await getDb()
for (const t0 = Date.now(); Date.now() - t0 < 300_000; await new Promise((x) => setTimeout(x, 700))) {
  const d = await db.collection(C.inbox).findOne({ messageId: guid })
  if (d && ['done', 'failed', 'ignored'].includes(d.status)) {
    const out = await db.collection(C.outbox).findOne({ messageId: guid })
    console.log(`[${d.status} · ${d.planner ?? '-'} · ${d.ms ?? '-'}ms] reply ${out ? out.status : 'not sent (unknown sender?)'}\n${d.reply ?? d.error ?? ''}`)
    process.exit(0)
  }
}
console.log('timed out — is `npm run server` running?')
process.exit(1)
