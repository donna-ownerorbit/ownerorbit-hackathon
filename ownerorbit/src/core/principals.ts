import { config, type Role } from '../config.ts'
import { C, getDb, mongoConfigured, normalizeHandle, rid } from '../db/mongo.ts'

/**
 * Who may text Donna. Deterministic, never decided by a model.
 * Sources: OWNERORBIT_PRINCIPALS (env) and the `principals` collection in MongoDB
 * ({ restaurantId, phone, name, role, active }), plus the team harness's identity records in the same
 * Atlas DB (users.handles + memberships.role — what `npm run seed` in harness/ writes), so one seed
 * authorizes a number for both. Precedence: env > principals > harness users.
 */
export interface PrincipalRow { phone: string; name: string; role: Role; active: boolean }

let rows = new Map<string, PrincipalRow>()
let loadedAt = 0
let loading: Promise<void> | null = null

export async function refreshPrincipals(maxAgeMs = 60_000) {
  if (!mongoConfigured() || Date.now() - loadedAt < maxAgeMs) return
  loading ??= (async () => {
    try {
      const db = await getDb()
      const [list, users, memberships] = await Promise.all([
        db.collection<PrincipalRow>(C.principals).find({ restaurantId: rid(), active: { $ne: false } }).toArray(),
        db.collection('users').find({ status: 'active' }, { projection: { name: 1, handles: 1 } }).toArray(),
        db.collection('memberships').find({}, { projection: { userId: 1, role: 1 } }).toArray(),
      ])
      const next = new Map<string, PrincipalRow>()
      const RANK = { owner: 2, manager: 1, staff: 0 } as const
      const roleOf = (r: unknown): Role => (r === 'owner' ? 'owner' : r === 'manager' || r === 'gm' ? 'manager' : 'staff')
      for (const u of users) {
        const ms = memberships.filter((m) => m.userId === u._id)
        if (!ms.length) continue // a user with no membership has no authority
        const role = ms.map((m) => roleOf(m.role)).sort((a, b) => RANK[b] - RANK[a])[0]
        for (const h of (u.handles ?? []) as string[]) next.set(normalizeHandle(h), { phone: h, name: String(u.name ?? h), role, active: true })
      }
      for (const p of list) next.set(normalizeHandle(p.phone), { phone: p.phone, name: p.name, role: p.role, active: true })
      rows = next
      loadedAt = Date.now()
    } catch (e) {
      console.warn('[principals]', (e as Error).message)
    } finally {
      loading = null
    }
  })()
  await loading
}

export function lookupPrincipal(from: string): { id: string; role: Role; name?: string } | null {
  const key = normalizeHandle(from)
  for (const [h, role] of Object.entries(config.principals)) if (normalizeHandle(h) === key) return { id: key, role, name: rows.get(key)?.name }
  const row = rows.get(key)
  return row ? { id: key, role: row.role, name: row.name } : null
}

export async function upsertPrincipal(p: { phone: string; name: string; role: Role; active?: boolean; github?: string }) {
  const db = await getDb()
  await db.collection(C.principals).updateOne(
    { restaurantId: rid(), phone: p.phone },
    { $set: { name: p.name, role: p.role, active: p.active ?? true, ...(p.github && { github: p.github }), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  )
  loadedAt = 0
}
