import { randomUUID } from 'node:crypto'
import type { Role } from '../config.ts'
import { C, getDb, rid } from '../db/mongo.ts'

/**
 * Long-lived business knowledge the Haiku agent reads and writes in MongoDB.
 *   playbooks  = how we do things (the dashboard's versioned `skills`; agent may only PROPOSE edits)
 *   memory     = contextual facts and owner preferences
 *   objectives = what the business is trying to achieve, with interventions and progress
 *   followups  = scheduled next actions the inbox worker runs later
 *   handoffs   = step-by-step instructions for systems no skill can operate (DoorDash, Uber Eats…)
 *   runs       = full agent traces (model, playbook versions, tool calls, verification)
 */

export interface Playbook { skillId: string; version: number; name: string; description: string; instructions: string }

export interface ObjectiveAction { id: string; text: string; status: 'todo' | 'awaiting_approval' | 'done' | 'dropped'; result?: string; at: Date }
export interface Objective {
  id: string; title: string; metric: string; unit: string
  baseline: number | null; current: number | null; target: number; deadline: string | null
  constraints: string[]; status: 'active' | 'achieved' | 'paused' | 'dropped'
  actions: ObjectiveAction[]; log: { at: Date; note: string; by: string }[]
  createdBy: string; createdAt: Date; updatedAt: Date
}

export interface FollowupDoc {
  id: string; restaurantId: string; task: string; dueAt: Date; status: 'scheduled' | 'running' | 'done' | 'failed'
  principal: string; role: Role; chat?: string; objectiveId?: string; createdAt: Date; lockedUntil?: Date; reply?: string
}

export type TaskKind = 'issue' | 'task' | 'inventory_count' | 'closing_check' | 'escalation' | 'approval_request'
export interface TaskDoc {
  id: string; kind: TaskKind; title: string; details: string; assignee: string | null; dueAt: Date | null
  priority: 'low' | 'normal' | 'high' | 'urgent'; status: 'open' | 'done' | 'cancelled'; objectiveId?: string
  result?: string; by: string; at: Date; updatedAt: Date
}

export interface ToolCallTrace { name: string; input: unknown; ok: boolean; result: string; ms: number }
export interface AgentRun {
  runId: string; messageId: string; principal: string; role: Role; text: string; model: string
  playbooks: { skillId: string; version: number }[]; calls: ToolCallTrace[]; iterations: number
  stopReason: string | null; reply: string; awaitingApproval: boolean
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; ms: number; at: Date
}

const scope = <T extends object>(extra: T = {} as T) => ({ restaurantId: rid(), ...extra })
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'objective'

export const brain = {
  /** Latest version of every enabled playbook. */
  async playbooks(): Promise<Playbook[]> {
    const db = await getDb()
    return db.collection(C.playbooks).aggregate<Playbook>([
      { $match: scope() },
      { $sort: { skillId: 1, version: -1 } },
      { $group: { _id: '$skillId', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $match: { enabled: true } },
      { $project: { _id: 0, skillId: 1, version: 1, name: 1, description: 1, instructions: 1 } },
      { $sort: { skillId: 1 } },
    ]).toArray()
  },

  /** Files a proposal the owner approves on the dashboard's Skills page. Never edits the live playbook. */
  async proposePlaybook(p: { skillId: string; name?: string; description?: string; instructions?: string; reason: string }) {
    const db = await getDb()
    const live = await db.collection(C.playbooks).find(scope({ skillId: p.skillId })).sort({ version: -1 }).limit(1).next()
    if (!live) throw new Error(`no playbook "${p.skillId}" — existing ids: ${(await this.playbooks()).map((x) => x.skillId).join(', ')}`)
    const proposal = Object.fromEntries((['name', 'description', 'instructions'] as const).filter((k) => p[k] !== undefined && p[k] !== live[k]).map((k) => [k, p[k]]))
    if (!Object.keys(proposal).length) throw new Error('proposal is identical to the current playbook')
    // Same shape the dashboard's POST /api/skills/:id/proposals writes, so its approve button applies it.
    const doc = { id: randomUUID(), ...scope(), kind: 'skill_edit', skillId: p.skillId, baseVersion: live.version as number, proposal, reason: p.reason, author: 'agent', status: 'pending', createdAt: new Date() }
    await db.collection(C.approvals).insertOne(doc)
    return { proposalId: doc.id, baseVersion: doc.baseVersion, fields: Object.keys(proposal) }
  },

  async memories(limit = 25) {
    const db = await getDb()
    return db.collection(C.memory).find(scope(), { projection: { _id: 0, topic: 1, fact: 1, at: 1 } }).sort({ at: -1 }).limit(limit).toArray()
  },
  async remember(topic: string, fact: string, by: string) {
    const db = await getDb()
    // Same topic + fact = same memory; refresh it instead of piling up duplicates.
    await db.collection(C.memory).updateOne(scope({ topic, fact }), { $set: { at: new Date(), by }, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
  },

  async objectives(includeClosed = false): Promise<Objective[]> {
    const db = await getDb()
    return db.collection<Objective>(C.objectives).find(scope(includeClosed ? {} : { status: 'active' }), { projection: { _id: 0, restaurantId: 0 } }).sort({ createdAt: 1 }).limit(20).toArray() as Promise<Objective[]>
  },
  async createObjective(o: Pick<Objective, 'title' | 'metric' | 'unit' | 'baseline' | 'target' | 'deadline' | 'constraints'> & { actions: string[] }, by: string) {
    const db = await getDb()
    const now = new Date()
    const doc: Objective & { restaurantId: string } = {
      ...scope(), id: `${slug(o.title)}-${randomUUID().slice(0, 6)}`, title: o.title, metric: o.metric, unit: o.unit,
      baseline: o.baseline, current: o.baseline, target: o.target, deadline: o.deadline, constraints: o.constraints, status: 'active',
      actions: o.actions.map((text) => ({ id: randomUUID().slice(0, 8), text, status: 'todo', at: now })),
      log: [{ at: now, note: 'Objective created', by }], createdBy: by, createdAt: now, updatedAt: now,
    }
    await db.collection(C.objectives).insertOne(doc)
    const { restaurantId, ...out } = doc
    void restaurantId
    return out
  },
  async updateObjective(id: string, u: { current?: number; status?: Objective['status']; note?: string; addActions?: string[]; actionId?: string; actionStatus?: ObjectiveAction['status']; actionResult?: string }, by: string) {
    const db = await getDb()
    const obj = await db.collection<Objective>(C.objectives).findOne(scope({ id }))
    if (!obj) throw new Error(`no objective "${id}"`)
    const now = new Date()
    const actions = [...obj.actions]
    if (u.actionId) {
      const a = actions.find((x) => x.id === u.actionId)
      if (!a) throw new Error(`objective has no action "${u.actionId}" (ids: ${actions.map((x) => x.id).join(', ')})`)
      if (u.actionStatus) a.status = u.actionStatus
      if (u.actionResult) a.result = u.actionResult
      a.at = now
    }
    for (const text of u.addActions ?? []) actions.push({ id: randomUUID().slice(0, 8), text, status: 'todo', at: now })
    const set: Partial<Objective> = { actions, updatedAt: now }
    if (u.current !== undefined) set.current = u.current
    if (u.status) set.status = u.status
    const note = u.note ?? [u.current !== undefined && `progress ${u.current}${obj.unit}`, u.status && `status ${u.status}`, u.actionId && `action ${u.actionId} → ${u.actionStatus ?? 'updated'}`].filter(Boolean).join('; ')
    await db.collection<Objective>(C.objectives).updateOne(scope({ id }), { $set: set, $push: { log: { at: now, note: note || 'updated', by } } })
    return { ...set, id }
  },

  async scheduleFollowup(f: Pick<FollowupDoc, 'task' | 'dueAt' | 'principal' | 'role' | 'chat' | 'objectiveId'>) {
    const db = await getDb()
    const doc: FollowupDoc = { ...scope(), ...f, id: randomUUID(), status: 'scheduled', createdAt: new Date() }
    await db.collection(C.followups).insertOne(doc)
    return { id: doc.id, dueAt: doc.dueAt }
  },
  async upcomingFollowups(limit = 10) {
    const db = await getDb()
    return db.collection(C.followups).find(scope({ status: 'scheduled' }), { projection: { _id: 0, id: 1, task: 1, dueAt: 1, objectiveId: 1 } }).sort({ dueAt: 1 }).limit(limit).toArray()
  },
  /** Atomically claims one due follow-up so two workers can never both run it. */
  async claimDueFollowup(): Promise<FollowupDoc | null> {
    const db = await getDb()
    const now = new Date()
    return db.collection<FollowupDoc>(C.followups).findOneAndUpdate(
      { ...scope(), $or: [{ status: 'scheduled', dueAt: { $lte: now } }, { status: 'running', lockedUntil: { $lt: now } }] },
      { $set: { status: 'running', lockedUntil: new Date(now.getTime() + 5 * 60_000) } },
      { sort: { dueAt: 1 }, returnDocument: 'after' },
    )
  },
  async finishFollowup(id: string, ok: boolean, reply: string) {
    const db = await getDb()
    await db.collection(C.followups).updateOne({ id }, { $set: { status: ok ? 'done' : 'failed', reply, finishedAt: new Date() }, $unset: { lockedUntil: '' } })
  },

  async handoff(h: { system: string; title: string; steps: string[]; verify: string; objectiveId?: string }, by: string) {
    const db = await getDb()
    const doc = { id: randomUUID(), ...scope(), ...h, status: 'open', by, at: new Date() }
    await db.collection(C.handoffs).insertOne(doc)
    return { id: doc.id }
  },

  /** Operations work for people: issues, assignments, inventory counts, closing checks, escalations, approval requests. */
  async createTask(t: Pick<TaskDoc, 'kind' | 'title' | 'details' | 'assignee' | 'dueAt' | 'priority' | 'objectiveId'>, by: string) {
    const db = await getDb()
    const now = new Date()
    const doc: TaskDoc & { restaurantId: string } = { ...scope(), ...t, id: `${t.kind}-${randomUUID().slice(0, 8)}`, status: 'open', by, at: now, updatedAt: now }
    await db.collection(C.tasks).insertOne(doc)
    // Re-read: the agent only reports what MongoDB actually holds.
    const saved = await db.collection(C.tasks).findOne(scope({ id: doc.id }), { projection: { _id: 0, id: 1, kind: 1, status: 1, assignee: 1, dueAt: 1 } })
    if (!saved) throw new Error('task was not saved')
    return saved
  },
  async updateTask(id: string, u: { status?: TaskDoc['status']; result?: string; assignee?: string }, by: string) {
    const db = await getDb()
    const set = { ...(u.status && { status: u.status }), ...(u.result && { result: u.result }), ...(u.assignee && { assignee: u.assignee }), updatedAt: new Date(), updatedBy: by }
    const r = await db.collection(C.tasks).findOneAndUpdate(scope({ id }), { $set: set }, { returnDocument: 'after', projection: { _id: 0, id: 1, status: 1, result: 1, assignee: 1 } })
    if (!r) throw new Error(`no task "${id}"`)
    return r
  },
  async openTasks(limit = 15) {
    const db = await getDb()
    return db.collection(C.tasks).find(scope({ status: 'open' }), { projection: { _id: 0, id: 1, kind: 1, title: 1, assignee: 1, dueAt: 1, priority: 1 } }).sort({ at: -1 }).limit(limit).toArray()
  },
  /** Latest instruction commits pulled from GitHub, and what was done with them. */
  async githubUpdates(limit = 5) {
    const db = await getDb()
    return db.collection(C.githubCommits).find(scope(), { projection: { _id: 0, sha: 1, repo: 1, message: 1, status: 1, committedAt: 1, 'author.name': 1, reply: 1, url: 1 } }).sort({ committedAt: -1 }).limit(limit).toArray()
  },

  async recordRun(r: AgentRun) {
    const db = await getDb()
    await db.collection(C.runs).insertOne({ ...scope(), ...r })
  },
}
