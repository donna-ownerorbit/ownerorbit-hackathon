import { createInterface } from 'node:readline/promises'
import { OwnerOrbit } from '../core/orbit.ts'
import { SandboxSession } from '../browser/session.ts'
import { flushTracing } from '../telemetry/tracing.ts'

/** Text Donna from the terminal through the exact pipeline iMessage uses. `--stage` shows the browser. */
const stage = process.argv.includes('--stage') || process.env.STAGE === '1'
const orbit = new OwnerOrbit(new SandboxSession({ stage }))
const blue = (s: string) => `\x1b[44m\x1b[97m ${s} \x1b[0m`
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`

console.log(gray('Starting the sandbox browser…'))
await orbit.session.start()
console.log(gray(`Connected to ${orbit.session.url} (${await orbit.session.mode()} data, api ${orbit.session.apiMode}). Type "help". Ctrl+C to quit.\n`))

const once = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ')
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (text: string) => {
  const out = await orbit.handle({ from: 'owner-cli', text, trusted: true })
  console.log(`${blue('Donna')} ${out.reply.replace(/\n/g, '\n       ')}`)
  console.log(gray(`        ${out.planner} · ${out.ms}ms${out.results.length ? ' · ' + out.results.map((r) => `${r.step.skill}:${r.outcome}${r.verification ? `(${r.verification.checks.filter((c) => c.ok).length}/${r.verification.checks.length} checks)` : ''}`).join(', ') : ''}`))
}
if (once) await ask(once)
else for (;;) {
  const text = (await rl.question('\x1b[1myou › \x1b[0m')).trim()
  if (!text) continue
  if (text === 'exit' || text === 'quit') break
  await ask(text)
}
rl.close()
await flushTracing()
await orbit.session.close()
