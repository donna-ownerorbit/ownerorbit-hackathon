import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { ChangeStream, ObjectId } from 'mongodb'
import { config, usesMockBluebubbles, type Role } from '../config.ts'
import { brain } from '../agent/brain.ts'
import type { OwnerOrbit, Outbound } from '../core/orbit.ts'
import { C, getDb, normalizeHandle, rid } from '../db/mongo.ts'
import { sendText } from '../transport/bluebubbles.ts'
import { GitHubSync, githubConfigured, recordCommitResult } from '../github/sync.ts'
import { HarnessBridge } from './harness-bridge.ts'

/**
 * MongoDB inbox → OwnerOrbit → outbox.
 *
 * Anything can drop an iMessage into `inbound_messages` (our BlueBubbles webhook, another adapter,
 * a script). Minimal document: { from: "+15105551234", text: "86 the nuggets" }; optional
 * messageId (dedupe key — use the BlueBubbles guid), chat (BlueBubbles chat guid), channel.
 * The worker claims documents atomically, runs them through the same core as every other
 * transport, writes the result back onto the document, and queues the reply in
 * `outbound_messages` (sent via BlueBubbles when configured, otherwise left `pending` for
 * whichever adapter owns delivery).
 */

export interface InboxDoc {
  _id: ObjectId
  messageId?: string; channel?: string; from: string; chat?: string | null; text: string; receivedAt?: Date
  status?: 'queued' | 'processing' | 'done' | 'ignored' | 'failed'
  attempts?: number; lockedUntil?: Date; claimedBy?: string
  reply?: string; planner?: string; ms?: number; error?: string; processedAt?: Date
  /** Set only by the harness bridge: sender already authenticated by the harness (users/memberships). */
  actAs?: { id: string; role: Role; name?: string; via?: string }
}

const MAX_ATTEMPTS = 3
const LEASE_MS = 4 * 60_000

export async function enqueue(m: { from: string; text: string; messageId?: string; chat?: string | null; channel?: string; actAs?: InboxDoc['actAs'] }) {
  const db = await getDb()
  const messageId = m.messageId ?? randomUUID()
  try {
    await db.collection(C.inbox).insertOne({ messageId, restaurantId: rid(), channel: m.channel ?? 'imessage', from: m.from, chat: m.chat ?? null, text: m.text, receivedAt: new Date(), status: 'queued', attempts: 0, ...(m.actAs && { actAs: m.actAs }) })
    return { queued: true, messageId }
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return { queued: false, messageId } // BlueBubbles webhook retry
    throw e
  }
}

export class InboxWorker {
  readonly id = `${hostname()}:${process.pid}`
  private draining = false
  private again = false
  private stream: ChangeStream | null = null
  private timers: NodeJS.Timeout[] = []
  private stopped = false
  processed = 0

  readonly github = new GitHubSync()
  readonly bridge = config.harnessBridge !== 'off' ? new HarnessBridge(() => this.kick()) : null

  constructor(private orbit: OwnerOrbit, private opts: { pollMs?: number; followupMs?: number } = {}) {}

  async start() {
    await getDb() // fail loudly on boot if Atlas is unreachable
    try {
      // Instant pickup on Atlas (replica set). Polling below is the safety net.
      this.stream = (await getDb()).collection(C.inbox).watch([{ $match: { operationType: 'insert' } }])
      this.stream.on('change', () => this.kick())
      this.stream.on('error', (e) => { console.warn('[inbox] change stream closed, polling only:', e.message); this.stream = null })
    } catch (e) {
      console.warn('[inbox] change stream unavailable, polling only:', (e as Error).message)
    }
    this.timers.push(setInterval(() => this.kick(), this.opts.pollMs ?? (this.stream ? 10_000 : 2_000)))
    this.timers.push(setInterval(() => this.followups(), this.opts.followupMs ?? 30_000))
    await this.bridge?.start().catch((e) => console.warn('[harness-bridge] not started:', (e as Error).message))
    if (githubConfigured() && config.github.pollMs > 0) this.timers.push(setInterval(() => void this.pullGithub(), config.github.pollMs))
    this.kick()
    void this.followups()
    if (githubConfigured()) void this.pullGithub()
  }

  /** MongoDB pulls the latest GitHub commits; new ones land in the inbox (the change stream wakes the drain). */
  private githubBusy = false
  async pullGithub() {
    if (this.stopped || this.githubBusy) return null
    this.githubBusy = true
    try {
      const r = await this.github.pull()
      for (const p of r.pulled) console.log(`🐙 github ${r.repo}@${p.sha} → ${p.status}${p.reason ? ` (${p.reason})` : ''}`)
      if (r.pulled.length) this.kick()
      return r
    } catch (e) {
      console.warn('[github] pull failed:', (e as Error).message)
      return null
    } finally {
      this.githubBusy = false
    }
  }

  async stop() {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    await this.bridge?.stop()
    await this.stream?.close().catch(() => undefined)
  }

  /** Coalesces wake-ups: one drain loop at a time, re-run if something arrived mid-drain. */
  kick() {
    if (this.stopped) return
    if (this.draining) { this.again = true; return }
    this.draining = true
    void (async () => {
      try {
        do {
          this.again = false
          for (let doc = await this.claim(); doc; doc = await this.claim()) await this.process(doc)
        } while (this.again && !this.stopped)
      } catch (e) {
        console.error('[inbox] drain failed:', (e as Error).message)
      } finally {
        this.draining = false
      }
    })()
  }

  private async claim(): Promise<InboxDoc | null> {
    const db = await getDb()
    const now = new Date()
    await db.collection(C.inbox).updateMany(
      { status: 'processing', lockedUntil: { $lt: now }, attempts: { $gte: MAX_ATTEMPTS }, restaurantId: { $in: [rid(), null] } },
      { $set: { status: 'failed', error: `gave up after ${MAX_ATTEMPTS} attempts` }, $unset: { lockedUntil: '' } },
    )
    // One message per sender at a time across all workers, so "YES" can't overtake the message it answers.
    const busy = await db.collection(C.inbox).distinct('from', { status: 'processing', lockedUntil: { $gte: now }, restaurantId: { $in: [rid(), null] } })
    return db.collection<InboxDoc>(C.inbox).findOneAndUpdate(
      {
        text: { $type: 'string' }, from: { $type: 'string', $nin: busy }, restaurantId: { $in: [rid(), null] },
        $or: [{ status: { $exists: false } }, { status: 'queued' }, { status: 'processing', lockedUntil: { $lt: now } }],
      },
      { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + LEASE_MS), claimedBy: this.id }, $inc: { attempts: 1 } },
      { sort: { _id: 1 }, returnDocument: 'after' },
    )
  }

  private async process(doc: InboxDoc) {
    const db = await getDb()
    const messageId = doc.messageId ?? String(doc._id)
    console.log(`📥 inbox ${doc.from}: ${doc.text}`)
    try {
      await recordCommitResult(messageId, { status: 'processing' })
      // Only the harness bridge may carry a pre-authenticated identity.
      const actAs = doc.channel === 'harness' && doc.actAs ? { id: normalizeHandle(doc.actAs.id), role: doc.actAs.role } : undefined
      const out = await this.orbit.handle({ from: doc.from, text: doc.text, messageId, chat: doc.chat ?? undefined, actAs, source: doc.channel === 'github' ? 'github' : undefined })
      const isGithub = doc.channel === 'github' || doc.channel === 'github-message'
      await db.collection(C.inbox).updateOne({ _id: doc._id }, {
        $set: { messageId, status: out.ignored ? 'ignored' : 'done', reply: out.reply, planner: out.planner, ms: out.ms, results: summarize(out), evals: out.evals ?? [], processedAt: new Date() },
        $unset: { lockedUntil: '', error: '' },
      })
      this.processed++
      await recordCommitResult(messageId, { status: 'done', reply: out.reply, results: summarize(out), planner: out.planner })
      if (isGithub && out.reply) {
        await this.github.pushReply(messageId, { text: doc.text, reply: out.reply, results: summarize(out), planner: out.planner ?? '' })
          .then((c) => c && console.log(`🐙 reply pushed → ${c.path}`), (e) => console.warn('[github] reply push failed:', (e as Error).message))
      }
      if (out.reply && !out.ignored && (out.planner !== 'auth' || config.replyToUnknown)) {
        console.log(`💬 → ${out.reply.replace(/\n/g, ' ⏎ ')}  [${out.planner}, ${out.ms}ms]`)
        // GitHub briefs report back to the author's iMessage (that's where they answer YES).
        const channel = isGithub || doc.channel === 'harness' ? 'imessage' : doc.channel ?? 'imessage'
        await this.reply({ messageId, chat: doc.chat ?? null, to: doc.from, text: isGithub ? `🐙 ${out.reply}` : out.reply, channel })
      }
    } catch (e) {
      const attempts = doc.attempts ?? 1
      console.error('[inbox] processing failed:', (e as Error).message)
      if (attempts >= MAX_ATTEMPTS) await recordCommitResult(messageId, { status: 'failed', error: (e as Error).message.slice(0, 500) }).catch(() => undefined)
      await db.collection(C.inbox).updateOne({ _id: doc._id }, {
        $set: { status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', error: (e as Error).message.slice(0, 500) },
        $unset: { lockedUntil: '' },
      })
    }
  }

  /** Every reply is recorded; BlueBubbles delivers it when configured, otherwise another adapter picks up `pending`. */
  async reply(r: { messageId: string; chat: string | null; to: string; text: string; channel: string }) {
    const db = await getDb()
    const { insertedId } = await db.collection(C.outbox).insertOne({ ...r, status: 'pending', createdAt: new Date() })
    if (r.channel !== 'imessage' || !r.chat || !(usesMockBluebubbles(r.chat) || config.bluebubbles.url)) return
    try {
      await sendText(r.chat, r.text, r.messageId)
      await db.collection(C.outbox).updateOne({ _id: insertedId }, { $set: { status: 'sent', via: usesMockBluebubbles(r.chat) ? 'mock-bluebubbles' : 'bluebubbles', sentAt: new Date() } })
    } catch (e) {
      console.error('[inbox] BlueBubbles send failed:', (e as Error).message)
      await db.collection(C.outbox).updateOne({ _id: insertedId }, { $set: { status: 'failed', error: (e as Error).message.slice(0, 300) } })
    }
  }

  /** Long-horizon loop: due follow-ups run as the person who scheduled them and report back to their chat. */
  private async followups() {
    if (this.stopped) return
    try {
      for (let f = await brain.claimDueFollowup(); f; f = await brain.claimDueFollowup()) {
        console.log(`⏰ follow-up ${f.id}: ${f.task}`)
        try {
          const out = await this.orbit.handle({ from: f.principal, text: f.task, messageId: `followup:${f.id}`, chat: f.chat, actAs: { id: f.principal, role: f.role } })
          await brain.finishFollowup(f.id, !out.results.some((r) => r.outcome === 'failed'), out.reply)
          if (out.reply) await this.reply({ messageId: `followup:${f.id}`, chat: f.chat ?? null, to: f.principal, text: `⏰ ${out.reply}`, channel: 'imessage' })
        } catch (e) {
          await brain.finishFollowup(f.id, false, (e as Error).message)
        }
      }
    } catch (e) {
      console.warn('[inbox] follow-ups:', (e as Error).message)
    }
  }
}

const summarize = (out: Outbound) => out.results.map((r) => ({ skill: r.step.skill, outcome: r.outcome, summary: r.summary, verified: r.verification?.ok ?? null, actionId: r.actionId, via: (r.data as { via?: string } | undefined)?.via ?? 'ownerorbit', attempts: r.attempts ?? 1 }))
