import { C, getDb, rid } from '../db/mongo.ts'
import { upsertPrincipal } from '../core/principals.ts'
import type { Role } from '../config.ts'

/** npm run principals -- add +15105551234 owner "Saddiq Jeelani" [--github <login-or-email>] | remove +1510… | list */
const argv = process.argv.slice(2)
const gi = argv.indexOf('--github')
const github = gi >= 0 ? argv.splice(gi, 2)[1]?.toLowerCase() : undefined
const [cmd, phone, role, ...name] = argv
const ROLES: Role[] = ['owner', 'manager', 'staff']
if (cmd === 'add') {
  if (!phone || !ROLES.includes(role as Role)) throw new Error(`usage: add <phone> <${ROLES.join('|')}> <name>`)
  await upsertPrincipal({ phone, role: role as Role, name: name.join(' ') || phone, github })
  console.log(`✓ ${phone} is ${role} of ${rid()}`)
} else if (cmd === 'remove') {
  if (!phone) throw new Error('usage: remove <phone>')
  await upsertPrincipal({ phone, role: 'staff', name: phone, active: false })
  console.log(`✓ ${phone} deactivated`)
}
const db = await getDb()
for (const p of await db.collection(C.principals).find({ restaurantId: rid() }).sort({ role: 1 }).toArray()) {
  console.log(`${p.active === false ? '✗' : '•'} ${String(p.phone).padEnd(16)} ${String(p.role).padEnd(8)} ${p.name}${p.github ? `  (github: ${p.github})` : ''}`)
}
process.exit(0)
