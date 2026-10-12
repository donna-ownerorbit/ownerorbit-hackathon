import { C, getDb } from '../db/mongo.ts'
import { enqueue } from '../inbox/worker.ts'

/**
 * Talk to the MongoDB inbox exactly like an external iMessage adapter would.
 *   npm run inbox -- send +15105551234 "mark chicken nuggets out of stock"   (waits for the reply)
 *   npm run inbox -- tail [n]
 */
const [cmd, ...rest] = process.argv.slice(2)
const db = await getDb()
if (cmd === 'send') {
  const [from, ...words] = rest
  if (!from || !words.length) throw new Error('usage: send <phone> <text…>')
  const { messageId } = await enqueue({ from, text: words.join(' '), channel: 'cli' })
  console.log(`queued ${messageId} — waiting for the worker (is "npm run server" or "npm run worker" running?)`)
  for (const t0 = Date.now(); Date.now() - t0 < 300_000; await new Promise((r) => setTimeout(r, 750))) {
    const d = await db.collection(C.inbox).findOne({ messageId })
    if (d && ['done', 'ignored', 'failed'].includes(d.status)) {
      console.log(`\n[${d.status} · ${d.planner ?? '-'} · ${d.ms ?? '-'}ms]\n${d.reply ?? d.error ?? ''}`)
      for (const r of d.results ?? []) console.log(`  · ${r.skill} ${r.outcome}${r.verified === null ? '' : r.verified ? ' ✓verified' : ' ✗unverified'}`)
      process.exit(d.status === 'failed' ? 1 : 0)
    }
  }
  console.log('timed out waiting')
  process.exit(2)
}
const n = Number(rest[0] ?? 15)
for (const d of (await db.collection(C.inbox).find().sort({ _id: -1 }).limit(n).toArray()).reverse()) {
  console.log(`${d.receivedAt?.toISOString?.() ?? ''} ${String(d.status ?? 'new').padEnd(10)} ${d.from}: ${d.text}${d.reply ? `\n    ↳ ${String(d.reply).replace(/\n/g, '\n      ')}` : ''}`)
}
process.exit(0)
