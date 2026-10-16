import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'
import { C, getDb, mongoConfigured, rid } from '../db/mongo.ts'
import type { Focus } from '../nlu/parser.ts'
import type { PlanStep } from './types.ts'

/** What Donna is waiting on from this person. Expires so a stale "yes" can't fire a destructive step. */
export type Pending =
  | { kind: 'confirm'; steps: PlanStep[]; reasons: string[]; text: string; expires: number; /** Parked by the Haiku agent: it gets a follow-up turn after the steps run. */ agent?: boolean }
  | { kind: 'choose'; question: string; options: { label: string; steps: PlanStep[] }[]; text: string; expires: number }
  | { kind: 'fill'; step: PlanStep; field: string; type: 'number' | 'text'; question: string; text: string; expires: number }

export interface Done { messageId: string; text: string; summaries: string[]; inverse: PlanStep[]; at: number; undone?: boolean; /** Set when the Haiku agent answered; reply is what it texted back. */ agent?: { reply: string } }

export interface Convo { pending?: Pending; focus: Focus; history: Done[] }

const TTL = 5 * 60_000

/**
 * Per-person conversation state (pending YES/choice, recent actions for undo, pronoun focus).
 * MongoDB (`conversations`) is the source of truth so any number of workers agree on what a "YES"
 * refers to: the core loads a person's state before handling their message and flushes it after.
 * The JSON file is only a local fallback when MongoDB isn't configured.
 */
export class Memory {
  private file = join(config.dataDir, 'memory.json')
  private data: Record<string, Convo> = {}
  private seen = new Set<string>()
  private dirty = new Set<string>()

  constructor() {
    mkdirSync(config.dataDir, { recursive: true })
    if (existsSync(this.file)) try { this.data = JSON.parse(readFileSync(this.file, 'utf8')) } catch { /* fresh */ }
  }

  get(who: string): Convo {
    const c = (this.data[who] ??= { focus: {}, history: [] })
    if (c.pending && c.pending.expires < Date.now()) c.pending = undefined
    return c
  }

  setPending(who: string, p: Pending extends infer T ? T extends Pending ? Omit<T, 'expires'> : never : never) { this.get(who).pending = { ...p, expires: Date.now() + TTL } as Pending; this.dirty.add(who); this.save() }
  clearPending(who: string) { this.get(who).pending = undefined; this.dirty.add(who); this.save() }

  remember(who: string, d: Done, focus: Focus) {
    const c = this.get(who)
    c.history.push(d)
    c.history = c.history.slice(-25)
    c.focus = { ...c.focus, ...focus }
    this.dirty.add(who)
    this.save()
  }

  /** Pull this person's latest state from MongoDB (another worker may have handled their last message). */
  async load(who: string) {
    if (!mongoConfigured()) return
    try {
      const doc = await (await getDb()).collection(C.conversations).findOne({ _id: `${rid()}:${who}` as never })
      // MongoDB is the source of truth: no document means a fresh conversation (e.g. after a reset), not "keep the stale local copy".
      this.data[who] = (doc?.convo as Convo | undefined) ?? { focus: {}, history: [] }
    } catch (e) { console.warn('[memory] load failed, using local state:', (e as Error).message) }
  }

  /** Write back everything changed since the last flush. */
  async flush() {
    const who = [...this.dirty]
    this.dirty.clear()
    if (!mongoConfigured() || !who.length) return
    try {
      const db = await getDb()
      await Promise.all(who.map((w) => db.collection(C.conversations).updateOne(
        { _id: `${rid()}:${w}` as never },
        { $set: { restaurantId: rid(), principal: w, convo: this.data[w], updatedAt: new Date() } },
        { upsert: true },
      )))
    } catch (e) {
      for (const w of who) this.dirty.add(w)
      console.warn('[memory] flush failed:', (e as Error).message)
    }
  }

  /** Webhook retries from BlueBubbles must not run a command twice. */
  firstTime(messageId: string) {
    if (this.seen.has(messageId)) return false
    this.seen.add(messageId)
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000))
    return true
  }

  save() { try { writeFileSync(this.file, JSON.stringify(this.data, null, 1)) } catch { /* disk full etc. */ } }
}
