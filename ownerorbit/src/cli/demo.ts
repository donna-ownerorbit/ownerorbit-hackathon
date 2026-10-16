import { createInterface } from 'node:readline/promises'
import { rmSync } from 'node:fs'
import { OwnerOrbit } from '../core/orbit.ts'
import { SandboxSession } from '../browser/session.ts'

/**
 * The stage run-of-show. Visible browser with captions + click highlights; each beat waits for
 * Enter (or --auto). Default is isolated (fresh seeded menu every run, production DB untouched).
 *   npm run demo                 isolated, press Enter between beats
 *   npm run demo -- --auto       hands-free
 *   npm run demo -- --live       against the real database; everything is undone at the end
 */
const live = process.argv.includes('--live')
const auto = process.argv.includes('--auto')
const headless = process.argv.includes('--headless')
if (!live) rmSync('.data/demo-profile', { recursive: true, force: true })
const orbit = new OwnerOrbit(new SandboxSession({ stage: !headless, headless, api: live ? 'live' : 'isolated', profileDir: live ? undefined : '.data/demo-profile' }))

const BEATS: { say: string; note: string }[] = [
  { say: 'Mark item Chicken Nuggets unavailable', note: 'The hero flow: iMessage → plan → skill → Playwright → verify against reloaded state.' },
  { say: "is anything 86'd right now?", note: 'Reads ground truth straight from the sandbox.' },
  { say: "we're slammed, pause orders for 30 min", note: 'Store-level control; verified via persisted pausedUntil + header badge.' },
  { say: '86 the chicken', note: 'Ambiguity → Donna asks instead of guessing.' },
  { say: '3', note: 'Pick an option by number.' },
  { say: 'raise all burgers 5% and round to .99', note: 'Bulk change → confirmation with a price preview.' },
  { say: 'yes', note: '11 items repriced through the UI, every one re-verified.' },
  { say: 'add Ranch for 50 cents to wing sauce', note: 'Modifier group edit through a dialog.' },
  { say: 'add Mango Lassi to sides', note: 'Missing info → one follow-up question.' },
  { say: '4.99', note: 'Slot filled; item created and verified.' },
  { say: 'accept all new orders', note: 'Kitchen flow on the live order queue.' },
  { say: 'morning brief', note: 'One-text status from the Home screen + state.' },
  { say: 'undo', note: 'Every write carries its inverse — undo replays it, verified.' },
  { say: 'nuggets are back and resume orders', note: 'Compound command → two skills, one reply.' },
]

const rl = createInterface({ input: process.stdin, output: process.stdout })
const bubble = (who: 'me' | 'donna', s: string) => who === 'me'
  ? console.log(`\n${' '.repeat(30)}\x1b[44m\x1b[97m ${s} \x1b[0m`)
  : console.log(`\x1b[100m\x1b[97m ${s.replace(/\n/g, ' \x1b[0m\n\x1b[100m\x1b[97m ')} \x1b[0m`)

await orbit.session.start()
console.log(`\x1b[90mStage ready · ${orbit.session.url} · ${await orbit.session.mode()} data${live ? '' : ' (isolated, fresh seed)'}\x1b[0m`)
for (const [i, b] of BEATS.entries()) {
  console.log(`\n\x1b[90m── ${i + 1}/${BEATS.length} · ${b.note}\x1b[0m`)
  if (!auto) await rl.question('\x1b[90m   ⏎ to send\x1b[0m')
  bubble('me', b.say)
  const out = await orbit.handle({ from: 'stage', text: b.say, trusted: true })
  bubble('donna', out.reply)
  const v = out.results.filter((r) => r.verification)
  console.log(`\x1b[90m   ${out.planner} · ${out.ms}ms${v.length ? ` · ${v.reduce((n, r) => n + r.verification!.checks.filter((c) => c.ok).length, 0)}/${v.reduce((n, r) => n + r.verification!.checks.length, 0)} checks passed` : ''}\x1b[0m`)
  if (auto) await new Promise((r) => setTimeout(r, 1500))
}
if (live) {
  console.log('\n\x1b[90mRestoring the live menu…\x1b[0m')
  for (let k = 0; k < 20; k++) {
    const out = await orbit.handle({ from: 'stage', text: 'undo', trusted: true })
    if (/nothing I can undo/.test(out.reply)) break
  }
}
if (!auto) await rl.question('\n\x1b[90mDone. ⏎ to close the browser\x1b[0m')
rl.close()
await orbit.session.close()
