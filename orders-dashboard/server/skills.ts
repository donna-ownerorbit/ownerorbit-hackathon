import { randomUUID } from 'node:crypto'
import type { Document } from 'mongodb'
import { COLLECTIONS as C, dbConfig, getDb } from './db.js'
import { audit, bool, HttpError, ID, num, pick, str, type Rule } from './shared.js'
import { DEFAULT_SKILLS } from './skills-seed.js'
import type { ApiResponse } from './api.js'

// Skills are append-only: every edit, revert or approved proposal inserts a new version.
// The latest version of a skillId is the live one; older versions stay for history and rollback.

const CONTENT: Record<string, Rule> = { name: str(80), description: str(300), instructions: str(8000) }
const EDIT: Record<string, Rule> = { ...CONTENT, enabled: bool, note: str(200), baseVersion: num(1, 1e6) }
const PROPOSAL: Record<string, Rule> = { ...CONTENT, reason: str(500), baseVersion: num(1, 1e6) }

type Author = 'seed' | 'dashboard' | 'agent'
interface SkillVersion {
  skillId: string; version: number; name: string; description: string; instructions: string
  enabled: boolean; author: Author; note: string; createdAt: Date
}

let ready: Promise<unknown> | null = null
function ensureSkills() {
  if (!ready) {
    ready = (async () => {
      const db = await getDb()
      const rid = dbConfig().restaurantId
      await Promise.all([
        db.collection(C.skills).createIndex({ restaurantId: 1, skillId: 1, version: -1 }, { unique: true }),
        db.collection(C.approvals).createIndex({ restaurantId: 1, id: 1 }, { unique: true }),
        db.collection(C.approvals).createIndex({ restaurantId: 1, status: 1, createdAt: -1 }),
      ])
      // Version 1 of each default, only if that skill has never existed. Never overwrites.
      const now = new Date()
      await db.collection(C.skills).bulkWrite(DEFAULT_SKILLS.map((s) => ({
        updateOne: {
          filter: { restaurantId: rid, skillId: s.skillId, version: 1 },
          update: { $setOnInsert: { ...s, restaurantId: rid, version: 1, enabled: true, author: 'seed', note: 'Starting version', createdAt: now } },
          upsert: true,
        },
      })), { ordered: false })
    })().catch((e) => { ready = null; throw e })
  }
  return ready
}

const view = (d: Document | null) => {
  if (!d) return null
  const { _id, restaurantId, ...rest } = d
  void _id; void restaurantId
  return rest as SkillVersion
}

async function latest(skillId: string) {
  const db = await getDb()
  return view(await db.collection(C.skills).find({ restaurantId: dbConfig().restaurantId, skillId }).sort({ version: -1 }).limit(1).next())
}

async function insertVersion(prev: SkillVersion | null, next: Omit<SkillVersion, 'version' | 'createdAt'>) {
  const db = await getDb()
  const doc = { ...next, restaurantId: dbConfig().restaurantId, version: (prev?.version ?? 0) + 1, createdAt: new Date() }
  try {
    await db.collection(C.skills).insertOne(doc)
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'skill was changed by someone else — reload and try again')
    throw e
  }
  await audit('skill', next.skillId, prev ? 'version' : 'create', prev && { version: prev.version }, { version: doc.version, author: next.author, note: next.note })
  return view(doc)!
}

export async function handleSkills(method: string, parts: string[], body: unknown): Promise<ApiResponse> {
  await ensureSkills()
  const db = await getDb()
  const rid = dbConfig().restaurantId
  const [resource, id, action] = parts

  if (resource === 'approvals') {
    if (method === 'GET' && !id) {
      const rows = await db.collection(C.approvals).find({ restaurantId: rid, status: 'pending' }, { projection: { _id: 0, restaurantId: 0 } }).sort({ createdAt: -1 }).limit(100).toArray()
      return { status: 200, json: { rows } }
    }
    if (method === 'POST' && id && (action === 'approve' || action === 'reject')) {
      const { note } = pick(body ?? {}, { note: str(200) }) as { note?: string }
      // Claim the proposal first so a double click can't apply it twice.
      const claimed = await db.collection(C.approvals).findOneAndUpdate(
        { restaurantId: rid, id, status: 'pending' },
        { $set: { status: action === 'approve' ? 'approved' : 'rejected', decidedAt: new Date(), decisionNote: note ?? '' } },
        { returnDocument: 'after' },
      )
      if (!claimed) throw new HttpError(404, 'no pending proposal with that id')
      if (action === 'reject') {
        await audit('approval', id, 'reject', null, { skillId: claimed.skillId })
        return { status: 200, json: { ok: true } }
      }
      const prev = await latest(claimed.skillId)
      if (!prev) throw new HttpError(404, 'skill no longer exists')
      const p = claimed.proposal as Partial<SkillVersion>
      const v = await insertVersion(prev, {
        skillId: prev.skillId, name: p.name ?? prev.name, description: p.description ?? prev.description,
        instructions: p.instructions ?? prev.instructions, enabled: prev.enabled, author: 'agent',
        note: `Approved proposal: ${claimed.reason}`.slice(0, 200),
      })
      await db.collection(C.approvals).updateOne({ restaurantId: rid, id }, { $set: { resultVersion: v.version } })
      return { status: 200, json: { ok: true, skill: v } }
    }
    throw new HttpError(404, 'no such endpoint')
  }

  // resource === 'skills'
  if (method === 'GET' && !id) {
    const [skills, pending] = await Promise.all([
      db.collection(C.skills).aggregate([
        { $match: { restaurantId: rid } },
        { $sort: { skillId: 1, version: -1 } },
        { $group: { _id: '$skillId', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
        { $sort: { createdAt: 1, skillId: 1 } },
      ]).toArray(),
      db.collection(C.approvals).aggregate([
        { $match: { restaurantId: rid, status: 'pending', kind: 'skill_edit' } },
        { $group: { _id: '$skillId', n: { $sum: 1 } } },
      ]).toArray(),
    ])
    const counts = new Map(pending.map((p) => [p._id as string, p.n as number]))
    return { status: 200, json: { skills: skills.map((s) => ({ ...view(s), pendingProposals: counts.get(s.skillId) ?? 0 })) } }
  }

  if (method === 'POST' && !id) {
    const skillId = (body as { skillId?: unknown })?.skillId
    if (typeof skillId !== 'string' || !ID.test(skillId)) throw new HttpError(400, 'skillId required (letters, numbers, dashes)')
    const c = pick(body, CONTENT) as Pick<SkillVersion, 'name' | 'description' | 'instructions'>
    if (!c.name?.trim() || !c.instructions?.trim()) throw new HttpError(400, 'name and instructions required')
    if (await latest(skillId)) throw new HttpError(409, 'a skill with that id already exists')
    const v = await insertVersion(null, { skillId, name: c.name.trim(), description: c.description ?? '', instructions: c.instructions, enabled: true, author: 'dashboard', note: 'Created' })
    return { status: 201, json: { skill: v } }
  }

  if (!id) throw new HttpError(404, 'no such endpoint')
  const prev = await latest(id)
  if (!prev) throw new HttpError(404, 'no such skill')

  if (method === 'GET' && !action) {
    const [versions, proposals] = await Promise.all([
      db.collection(C.skills).find({ restaurantId: rid, skillId: id }).sort({ version: -1 }).limit(100).toArray(),
      db.collection(C.approvals).find({ restaurantId: rid, kind: 'skill_edit', skillId: id, status: 'pending' }, { projection: { _id: 0, restaurantId: 0 } }).sort({ createdAt: -1 }).toArray(),
    ])
    return { status: 200, json: { versions: versions.map(view), proposals } }
  }

  if (method === 'PUT' && !action) {
    const e = pick(body, EDIT) as Partial<SkillVersion> & { baseVersion?: number }
    if (e.baseVersion !== undefined && e.baseVersion !== prev.version) throw new HttpError(409, `skill is now at v${prev.version} — reload to see the latest`)
    const next = {
      skillId: id, name: e.name?.trim() || prev.name, description: e.description ?? prev.description,
      instructions: e.instructions ?? prev.instructions, enabled: e.enabled ?? prev.enabled,
    }
    if (!next.instructions.trim()) throw new HttpError(400, 'instructions cannot be empty')
    if (next.name === prev.name && next.description === prev.description && next.instructions === prev.instructions && next.enabled === prev.enabled) {
      return { status: 200, json: { skill: prev, unchanged: true } }
    }
    const note = e.note?.trim() || (next.enabled !== prev.enabled && next.instructions === prev.instructions ? (next.enabled ? 'Enabled' : 'Disabled') : 'Edited')
    return { status: 200, json: { skill: await insertVersion(prev, { ...next, author: 'dashboard', note }) } }
  }

  if (method === 'POST' && action === 'revert') {
    const { version } = pick(body, { version: num(1, 1e6) }) as { version?: number }
    const old = view(await db.collection(C.skills).findOne({ restaurantId: rid, skillId: id, version }))
    if (!old) throw new HttpError(404, 'no such version')
    if (old.version === prev.version) return { status: 200, json: { skill: prev, unchanged: true } }
    const v = await insertVersion(prev, {
      skillId: id, name: old.name, description: old.description, instructions: old.instructions,
      enabled: prev.enabled, author: 'dashboard', note: `Reverted to v${old.version}`,
    })
    return { status: 200, json: { skill: v } }
  }

  // Agents never edit skills directly: they file a proposal the owner approves or rejects.
  if (method === 'POST' && action === 'proposals') {
    const p = pick(body, PROPOSAL) as Partial<SkillVersion> & { reason?: string; baseVersion?: number }
    if (!p.reason?.trim()) throw new HttpError(400, 'reason required')
    const proposal = Object.fromEntries((['name', 'description', 'instructions'] as const).filter((k) => p[k] !== undefined && p[k] !== prev[k]).map((k) => [k, p[k]]))
    if (!Object.keys(proposal).length) throw new HttpError(400, 'proposal is identical to the current version')
    const doc = {
      id: randomUUID(), restaurantId: rid, kind: 'skill_edit', skillId: id, baseVersion: p.baseVersion ?? prev.version,
      proposal, reason: p.reason.trim(), author: 'agent', status: 'pending', createdAt: new Date(),
    }
    await db.collection(C.approvals).insertOne(doc)
    await audit('approval', doc.id, 'propose', null, { skillId: id, fields: Object.keys(proposal) }, 'agent')
    return { status: 201, json: { ok: true, id: doc.id } }
  }

  throw new HttpError(404, 'no such endpoint')
}
