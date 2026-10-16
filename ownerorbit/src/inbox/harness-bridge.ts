import type { ChangeStream, Document, ObjectId } from 'mongodb'
import { config, type Role } from '../config.ts'
import { getDb, rid } from '../db/mongo.ts'
import { enqueue } from './worker.ts'

/**
 * Bridge from the team harness (donna-ownerorbit/ownerorbit-hackathon → harness/) into Donna's inbox.
 *
 * The harness owns the BlueBubbles webhook. For every iMessage it writes to the shared Atlas DB:
 *   audit_events { type: 'message.received', tenantId, actorUserId, data: { text, messageId }, at }
 * and, when its regex intent parser can't handle the text,
 *   audit_events { type: 'intent.unknown', tenantId, actorUserId, data: { text }, at }
 * The sender was already authenticated by the harness's deterministic code (users.handles →
 * memberships.role), so we act as that user/role. HARNESS_BRIDGE=fallback (default) only takes the
 * messages the harness couldn't handle; =all takes every message (only if the harness isn't acting).
 */

const COLL = { get events() { return config.harnessEventsCollection }, users: 'users', memberships: 'memberships', state: 'bridge_state' }
const TYPES = { all: 'message.received', fallback: 'intent.unknown' } as const

interface HarnessEvent { _id: ObjectId; type: string; tenantId: string | null; actorUserId: string | null; data?: { text?: string; messageId?: string }; at: Date }

export class HarnessBridge {
  private stream: ChangeStream | null = null
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private again = false
  private stopped = false
  forwarded = 0

  constructor(private onQueued: () => void = () => undefined) {}

  /** One cursor per OwnerOrbit tenant + source collection. */
  private get stateId() { return `harness:${rid()}:${COLL.events}` }

  private get mode() { return config.harnessBridge as 'all' | 'fallback' }

  async start() {
    const db = await getDb()
    // First run: start from now, never replay old history.
    const state = await db.collection(COLL.state).findOne({ _id: this.stateId as never })
    if (!state) {
      const last = await db.collection(COLL.events).find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next()
      await db.collection(COLL.state).updateOne({ _id: this.stateId as never }, { $setOnInsert: { cursor: last?._id ?? null, at: new Date() } }, { upsert: true })
    }
    try {
      this.stream = db.collection(COLL.events).watch([{ $match: { operationType: 'insert', 'fullDocument.type': TYPES[this.mode] } }])
      this.stream.on('change', () => this.kick())
      this.stream.on('error', () => { this.stream = null })
    } catch { /* polling only */ }
    this.timer = setInterval(() => this.kick(), this.stream ? 5_000 : 1_500)
    this.kick()
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.stream?.close().catch(() => undefined)
  }

  kick() {
    if (this.stopped) return
    if (this.busy) { this.again = true; return }
    this.busy = true
    void (async () => {
      try { do { this.again = false; await this.drain() } while (this.again && !this.stopped) }
      catch (e) { console.warn('[harness-bridge]', (e as Error).message) }
      finally { this.busy = false }
    })()
  }

  private async drain() {
    const db = await getDb()
    const state = await db.collection(COLL.state).findOne({ _id: this.stateId as never })
    const q: Document = { type: TYPES[this.mode] }
    if (state?.cursor) q._id = { $gt: state.cursor }
    const events = await db.collection<HarnessEvent>(COLL.events).find(q).sort({ _id: 1 }).limit(50).toArray()
    for (const e of events) {
      await this.forward(e).catch((err) => console.warn('[harness-bridge] skip', String(e._id), (err as Error).message))
      await db.collection(COLL.state).updateOne({ _id: this.stateId as never }, { $set: { cursor: e._id, at: new Date() } })
    }
  }

  private async forward(e: HarnessEvent) {
    const db = await getDb()
    const text = e.data?.text?.trim()
    if (!text || !e.actorUserId) return
    // intent.unknown carries no messageId: recover it from the matching message.received.
    let messageId = e.data?.messageId
    if (!messageId) {
      const rec = await db.collection<HarnessEvent>(COLL.events).findOne(
        { type: 'message.received', actorUserId: e.actorUserId, 'data.text': e.data?.text, _id: { $lte: e._id } }, { sort: { _id: -1 } })
      messageId = rec?.data?.messageId ?? String(e._id)
    }
    const user = await db.collection(COLL.users).findOne({ _id: e.actorUserId as never, status: 'active' })
    if (!user) return
    const handles = (user.handles ?? []) as string[]
    const handle = handles.find((h) => /^\+?\d{10,15}$/.test(h)) ?? handles[0]
    if (!handle) return
    const membership = await db.collection(COLL.memberships).findOne({ tenantId: e.tenantId, userId: e.actorUserId })
    const role: Role = membership?.role === 'owner' ? 'owner' : membership?.role === 'manager' ? 'manager' : 'staff'
    const r = await enqueue({
      from: handle, text, messageId, channel: 'harness', chat: `iMessage;-;${handle}`,
      actAs: { id: handle, role, name: user.name as string, via: `harness:${e.tenantId}/${e.actorUserId}` },
    })
    if (r.queued) {
      this.forwarded++
      console.log(`🔗 harness → Donna (${this.mode}) ${user.name ?? handle} [${role}]: ${text}`)
      this.onQueued()
    }
  }
}
