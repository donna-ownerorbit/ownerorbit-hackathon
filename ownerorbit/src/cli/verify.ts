import { spawnSync } from 'node:child_process'

/**
 * One command to trust the build:  npm run verify            (everything, ~5 min)
 *                                  npm run verify -- --quick (typecheck + unit + core/security evals, no model)
 *   1. typecheck        tsc
 *   2. unit             node:test (parser, agent loop with a scripted model, GitHub sync)
 *   3. e2e              every skill through the real pipeline against the deployed dashboard (isolated API)
 *   4. evals            behaviour scenarios with real Haiku + MongoDB in the eval tenant
 */
const quick = process.argv.includes('--quick')
const pass = process.argv.slice(2).filter((a) => a !== '--quick')
const stages: [string, string[]][] = [
  ['typecheck', ['run', '-s', 'typecheck']],
  ['unit', ['test']],
  ...(quick ? [] : [['e2e', ['run', '-s', 'e2e']] as [string, string[]]]),
  ['evals', ['run', '-s', 'evals', '--', ...(quick ? ['--tier=core'] : []), ...pass]],
  ...(quick ? [['evals (security)', ['run', '-s', 'evals', '--', '--tier=security', '--only=sec.st']] as [string, string[]]] : []),
]
// Tests must never touch production: fingerprint the live dashboard before and after.
const PROD = process.env.SANDBOX_URL ?? 'https://orders-dashboard-eight-sepia.vercel.app'
async function prodPrint() {
  const r = await fetch(`${PROD}/api/state`, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json() as Promise<{ items: { id: string; status: string; price: number }[]; categories: { id: string; status: string }[]; restaurant: { accepting: boolean; pausedUntil: number | null } }>)
  return Object.fromEntries([...r.items.map((i) => [i.id, `${i.status}@${i.price}`]), ...r.categories.map((c) => [`cat:${c.id}`, c.status]), ['accepting', `${r.restaurant.accepting}/${r.restaurant.pausedUntil}`]])
}
const prodBefore = await prodPrint().catch(() => null)
const summary: string[] = []
let ok = true
for (const [name, cmd] of stages) {
  const t = Date.now()
  console.log(`\n━━━ ${name} ━━━`)
  const r = spawnSync('npm', cmd, { stdio: 'inherit' })
  const good = r.status === 0
  ok &&= good
  summary.push(`${good ? '✅' : '❌'} ${name.padEnd(18)} ${((Date.now() - t) / 1000).toFixed(0)}s`)
}
const prodAfter = prodBefore && await prodPrint().catch(() => null)
const drift = prodBefore && prodAfter ? Object.keys({ ...prodBefore, ...prodAfter }).filter((k) => prodBefore[k] !== prodAfter[k]) : null
if (drift?.length) ok = false
summary.push(drift === null ? '⚠️  production untouched  (could not read prod state)' : `${drift.length ? '❌' : '✅'} production untouched${drift.length ? `  CHANGED: ${drift.map((k) => `${k} ${prodBefore![k]}→${prodAfter![k]}`).join(', ')} (or someone used the live dashboard meanwhile)` : ''}`)
console.log(`\n━━━ verify ━━━\n${summary.join('\n')}\n${ok ? 'ALL GREEN' : 'FAILURES — see above'}`)
process.exit(ok ? 0 : 1)
