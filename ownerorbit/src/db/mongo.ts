import { MongoClient, type Db } from 'mongodb'
import { config } from '../config.ts'

/**
 * The business brain lives in the same Atlas database as the dashboard (`ownerorbit`), so the
 * agent, the website and the iMessage inbox all read one source of truth. Every collection
 * below is scoped by restaurantId.
 */
export const C = {
  inbox: 'inbound_messages',
  outbox: 'outbound_messages',
  principals: 'principals',
  playbooks: 'skills', // owned by the dashboard (/skills page): append-only versions
  approvals: 'approvals', // owned by the dashboard: owner approves agent proposals there
  memory: 'business_memory',
  objectives: 'objectives',
  followups: 'followups',
  handoffs: 'handoffs',
  runs: 'agent_runs',
  conversations: 'conversations',
  githubCommits: 'github_commits',
  tasks: 'tasks',
} as const

export const mongoConfigured = () => !!config.mongo.uri && !config.mongo.uri.includes('<')
export const rid = () => config.restaurantId

let db: Promise<Db> | null = null

export function getDb(): Promise<Db> {
  if (!mongoConfigured()) return Promise.reject(new Error('MONGODB_URI is not set'))
  db ??= new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10, appName: 'ownerorbit-agent' })
    .connect()
    .then(async (client) => {
      const d = client.db(config.mongo.db)
      await Promise.all([
        // Partial: external writers may omit messageId; those dedupe on nothing rather than colliding on null.
        d.collection(C.inbox).createIndex({ messageId: 1 }, { unique: true, partialFilterExpression: { messageId: { $type: 'string' } } }),
        d.collection(C.inbox).createIndex({ status: 1, receivedAt: 1 }),
        d.collection(C.outbox).createIndex({ status: 1, createdAt: 1 }),
        d.collection(C.principals).createIndex({ restaurantId: 1, phone: 1 }, { unique: true }),
        d.collection(C.memory).createIndex({ restaurantId: 1, at: -1 }),
        d.collection(C.objectives).createIndex({ restaurantId: 1, id: 1 }, { unique: true }),
        d.collection(C.followups).createIndex({ status: 1, dueAt: 1 }),
        d.collection(C.handoffs).createIndex({ restaurantId: 1, at: -1 }),
        d.collection(C.runs).createIndex({ restaurantId: 1, at: -1 }),
        d.collection(C.runs).createIndex({ messageId: 1 }),
        d.collection(C.githubCommits).createIndex({ restaurantId: 1, repo: 1, sha: 1 }, { unique: true }),
        d.collection(C.githubCommits).createIndex({ messageId: 1 }),
        d.collection(C.tasks).createIndex({ restaurantId: 1, status: 1, at: -1 }),
      ])
      return d
    })
    .catch((e) => {
      db = null
      throw new Error(`MongoDB unavailable: ${(e as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/, '[uri]')}`)
    })
  return db
}

/** Phone numbers in any format → last 10 digits (matches OwnerOrbit.identify). */
export const normalizeHandle = (h: string) => { const d = h.replace(/[^\d]/g, ''); return d.length >= 10 ? d.slice(-10) : h.trim().toLowerCase() }
