import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MongoClient, type Db } from 'mongodb'
import { config } from '../config.ts'
import type { Check, VerifyLevel } from '../core/types.ts'

/** One executed skill step: what was asked, what was done, and the proof. */
export interface ActionRecord {
  actionId: string
  messageId: string
  principal: string
  role: string
  skill: string
  input: unknown
  outcome: 'done' | 'noop' | 'failed' | 'needs_confirmation' | 'denied'
  summary: string
  error?: string
  touched?: number
  verification?: { ok: boolean; level: VerifyLevel; checks: Check[] }
  attempts: number
  timings: { startedAt: string; runMs?: number; verifyMs?: number; totalMs: number }
  sandbox: { url: string; mode?: 'db' | 'local'; apiMode: string }
  artifacts: { before?: string | null; after?: string | null; trace?: string | null }
  beforeState?: unknown
  undoOf?: string
  at: Date
}

export interface MessageRecord {
  messageId: string; principal: string; chat?: string; text: string; planner: string; plan: unknown; reply: string; ms: number; at: Date
}

export interface EvidenceStore {
  action(r: ActionRecord): Promise<void>
  message(r: MessageRecord): Promise<void>
  recent(limit: number): Promise<ActionRecord[]>
  describe(): string
}

class JsonlStore implements EvidenceStore {
  private dir = join(config.dataDir, 'evidence')
  private mem: ActionRecord[] = []
  constructor() { mkdirSync(this.dir, { recursive: true }) }
  async action(r: ActionRecord) { this.mem.push(r); appendFileSync(join(this.dir, 'actions.jsonl'), JSON.stringify(r) + '\n') }
  async message(r: MessageRecord) { appendFileSync(join(this.dir, 'messages.jsonl'), JSON.stringify(r) + '\n') }
  async recent(limit: number) { return this.mem.slice(-limit).reverse() }
  describe() { return `jsonl (${this.dir})` }
}

class MongoStore implements EvidenceStore {
  private db: Promise<Db>
  private fallback = new JsonlStore()
  constructor(uri: string, name: string) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: 'ownerorbit-core' })
    this.db = client.connect().then(async (c) => {
      const db = c.db(name)
      await Promise.all([
        db.collection('agent_actions').createIndex({ at: -1 }),
        db.collection('agent_actions').createIndex({ skill: 1, at: -1 }),
        db.collection('agent_actions').createIndex({ messageId: 1 }),
        db.collection('agent_messages').createIndex({ at: -1 }),
      ])
      return db
    })
    this.db.catch((e) => console.warn('[evidence] MongoDB unavailable, using JSONL:', (e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/, '[uri]')))
  }
  private async use<T>(fn: (db: Db) => Promise<T>, fb: () => Promise<T>) {
    try { return await fn(await this.db) } catch { return fb() }
  }
  async action(r: ActionRecord) { await this.use((db) => db.collection('agent_actions').insertOne({ ...r }).then(() => undefined), () => this.fallback.action(r)) }
  async message(r: MessageRecord) { await this.use((db) => db.collection('agent_messages').insertOne({ ...r }).then(() => undefined), () => this.fallback.message(r)) }
  async recent(limit: number) {
    return this.use((db) => db.collection<ActionRecord>('agent_actions').find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray() as Promise<ActionRecord[]>, () => this.fallback.recent(limit))
  }
  describe() { return `mongodb (${config.mongo.db}.agent_actions)` }
}

export const evidence: EvidenceStore = config.mongo.uri && !config.mongo.uri.includes('<') ? new MongoStore(config.mongo.uri, config.mongo.db) : new JsonlStore()
