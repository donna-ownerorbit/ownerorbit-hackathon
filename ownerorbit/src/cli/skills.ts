import { SKILLS, jsonSchema } from '../skills/index.ts'

/** Print the skill catalog (npm run skills [-- --json]). */
if (process.argv.includes('--json')) console.log(JSON.stringify(SKILLS.map((s) => ({ id: s.id, title: s.title, risk: s.risk, minRole: s.minRole, input: jsonSchema(s), examples: s.examples })), null, 2))
else {
  for (const [i, s] of SKILLS.entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${s.id.padEnd(28)} ${s.risk.padEnd(11)} ${s.minRole.padEnd(7)} ${s.title}`)
    console.log(`    e.g. "${s.examples[0]}"`)
  }
  console.log(`\n${SKILLS.length} skills`)
}
