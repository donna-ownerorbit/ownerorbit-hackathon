import { config } from '../config.ts'

/**
 * The whole demo without a phone: each line goes through /phone/send, which fires a real
 * BlueBubbles-shaped webhook at the running server; Donna's replies come back through the
 * BlueBubbles REST stand-in. Watch the same conversation live at http://localhost:<port>/phone.
 *   npm run demo:imessage                 # scripted run
 *   npm run demo:imessage -- "86 the wings"   # one message
 */
const BASE = `http://localhost:${config.port}`
const SCRIPT = [
  'Mark chicken nuggets out of stock',
  'nuggets are back',
  'We need a corporate catering page to grow catering to $15k/month. We do about $6k now',
  'YES',
  "What's 86'd right now?",
  'Our DoorDash listing still shows the old hours, how do I fix that?',
]
const lines = process.argv.slice(2).length ? [process.argv.slice(2).join(' ')] : SCRIPT
const W = Math.min(process.stdout.columns || 100, 100)
const wrap = (s: string, w: number) => s.split('\n').flatMap((p) => { const out: string[] = []; let cur = ''; for (const word of p.split(' ')) { if ((cur + ' ' + word).trim().length > w) { out.push(cur); cur = word } else cur = (cur + ' ' + word).trim() } out.push(cur); return out })
const me = (s: string) => wrap(s, 54).forEach((l) => console.log(' '.repeat(Math.max(0, W - l.length - 4)) + `\x1b[44m\x1b[97m ${l} \x1b[0m`))
const them = (s: string) => wrap(s, 64).forEach((l) => console.log(`  \x1b[47m\x1b[30m ${l} \x1b[0m`))
const gray = (s: string) => console.log(`  \x1b[90m${s}\x1b[0m`)

type Thread = { messages: { dir: string; text: string; ref: string | null; guid: string }[]; runs: Record<string, { status: string; planner?: string; ms?: number; results?: { skill: string; outcome: string; verified: boolean | null; via?: string }[]; evals?: { name: string; pass: boolean; detail: string }[] }> }
const thread = async () => (await (await fetch(`${BASE}/phone/thread`)).json()) as Thread

try { await fetch(`${BASE}/phone/config`) } catch { console.error(`OwnerOrbit isn't running on ${BASE}. Start it: npm run server`); process.exit(1) }
console.log(`\n\x1b[1m📱 Donna · mock iMessage → ${BASE}/phone\x1b[0m\n`)
for (const text of lines) {
  me(text)
  const r = await fetch(`${BASE}/phone/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  const { guid } = (await r.json()) as { guid: string }
  process.stdout.write('  \x1b[90mDonna is typing…\x1b[0m')
  let t: Thread | null = null
  for (const t0 = Date.now(); Date.now() - t0 < 180_000; await new Promise((x) => setTimeout(x, 700))) {
    t = await thread()
    const run = t.runs[guid]
    if (run && ['done', 'failed', 'ignored'].includes(run.status) && (run.status !== 'done' || t.messages.some((m) => m.ref === guid))) break
  }
  process.stdout.write('\r\x1b[K')
  const run = t?.runs[guid]
  for (const m of t?.messages.filter((x) => x.ref === guid) ?? []) them(m.text)
  if (run?.planner) {
    const writes = (run.results ?? []).filter((x) => x.verified !== null)
    const ev = run.evals ?? []
    gray(`${run.planner} · ${((run.ms ?? 0) / 1000).toFixed(1)}s${writes.length ? ` · verified ${writes.filter((x) => x.verified).length}/${writes.length}` : ''}${(run.results ?? []).some((x) => x.via === 'browser-exec') ? ' · browser-exec' : ''} · evals ${ev.filter((e) => e.pass).length}/${ev.length}${ev.some((e) => !e.pass) ? ' ✗ ' + ev.filter((e) => !e.pass).map((e) => e.name).join(',') : ''}`)
  } else if (run?.status !== 'done') gray(`(${run?.status ?? 'no reply'})`)
  console.log()
}
process.exit(0)
