import { MongoClient, type Db } from 'mongodb'
import { attachDatabasePool } from '@vercel/functions'

// One client per server instance, reused across requests (and across HMR in dev).
const g = globalThis as unknown as { __mongo?: Promise<MongoClient> }

export class DbNotConfigured extends Error {}

export function dbConfig() {
  return {
    uri: process.env.MONGODB_URI ?? '',
    name: process.env.MONGODB_DB || 'ownerorbit',
    restaurantId: process.env.RESTAURANT_ID || 'falafel-flare',
  }
}

export async function getDb(): Promise<Db> {
  const { uri, name } = dbConfig()
  if (!uri || uri.includes('<db_password>')) throw new DbNotConfigured('MONGODB_URI is not set')
  if (!g.__mongo) {
    const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000, appName: 'orders-dashboard' })
    attachDatabasePool(client)
    g.__mongo = client.connect().catch((e) => {
      g.__mongo = undefined
      throw e
    })
  }
  return (await g.__mongo).db(name)
}

export const COLLECTIONS = {
  restaurants: 'restaurants',
  categories: 'menu_categories',
  items: 'menu_items',
  modifierGroups: 'modifier_groups',
  orders: 'orders',
  audit: 'audit_log',
  sessions: 'agent_sessions',
  runs: 'agent_runs',
  approvals: 'approvals',
  objectives: 'objectives',
  followups: 'followups',
  skills: 'skills',
  memory: 'business_memory',
} as const
