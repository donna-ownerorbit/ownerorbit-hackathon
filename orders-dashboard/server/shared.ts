import type { Document } from 'mongodb'
import { COLLECTIONS as C, dbConfig, getDb } from './db.js'
import { STORES } from '../src/data.js'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const STATUSES = ['available', 'sold_out_today', 'sold_out', 'hidden']
export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'canceled']

/* ---------------- validation ---------------- */
export type Rule = (v: unknown) => unknown
export const str = (max: number): Rule => (v) => { if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `expected string ≤ ${max}`); return v }
export const num = (min: number, max: number): Rule => (v) => {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `expected number ${min}–${max}`)
  return n
}
export const bool: Rule = (v) => { if (typeof v !== 'boolean') throw new HttpError(400, 'expected boolean'); return v }
export const oneOf = (opts: string[]): Rule => (v) => { if (typeof v !== 'string' || !opts.includes(v)) throw new HttpError(400, `expected one of ${opts.join(', ')}`); return v }
export const arr = (rule: Rule, max = 50): Rule => (v) => { if (!Array.isArray(v) || v.length > max) throw new HttpError(400, 'expected array'); return v.map(rule) }
export const obj = (shape: Record<string, Rule>): Rule => (v) => pick(v, shape)
export const nullable = (rule: Rule): Rule => (v) => (v === null ? null : rule(v))
export const image: Rule = (v) => {
  if (v === null || v === undefined) return null
  const s = str(1_500_000)(v) as string
  if (!s.startsWith('/') && !s.startsWith('data:image/') && !s.startsWith('https://')) throw new HttpError(400, 'invalid image')
  return s
}

export function pick(input: unknown, shape: Record<string, Rule>) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'expected JSON object')
  const out: Record<string, unknown> = {}
  for (const [k, rule] of Object.entries(shape)) {
    const v = (input as Record<string, unknown>)[k]
    if (v === undefined) continue
    try { out[k] = rule(v) } catch (e) { throw new HttpError(400, `${k}: ${(e as Error).message}`) }
  }
  return out
}

export const ITEM: Record<string, Rule> = {
  categoryId: str(80), name: str(120), description: str(1200), price: num(0, 10000), image, status: oneOf(STATUSES),
  tax: str(10), sizes: arr(obj({ id: str(60), name: str(60), price: num(0, 10000) }), 20), sku: str(60), unit: str(30),
  stock: num(-1e6, 1e6), barcodes: arr(str(80), 20), trackInventory: bool, modifierGroupIds: arr(str(80), 30), isNew: bool,
  orders30d: num(0, 1e7),
}
export const CATEGORY: Record<string, Rule> = { name: str(80), description: str(500), links: num(0, 20), status: oneOf(STATUSES), collapsed: bool }
export const MODGROUP: Record<string, Rule> = {
  name: str(80), min: num(0, 50), max: num(0, 50), required: bool,
  options: arr(obj({ id: str(60), name: str(80), price: num(0, 1000) }), 50),
}
export const RESTAURANT: Record<string, Rule> = {
  storeId: oneOf(STORES.map((s) => s.id)), accepting: bool, pausedUntil: nullable(num(0, 1e14)), menuSyncedAt: num(0, 1e14),
}
export const ID = /^[a-z0-9][a-z0-9-]{0,99}$/i

/* ---------------- helpers ---------------- */
export const strip = <T extends Document>(d: T | null) => {
  if (!d) return d
  const { _id, restaurantId, sort, createdAt, updatedAt, ...rest } = d as Document
  void _id; void restaurantId; void sort; void createdAt; void updatedAt
  return rest
}

export async function audit(entity: string, entityId: string, action: string, before: unknown, after: unknown, actor = 'dashboard') {
  const db = await getDb()
  await db.collection(C.audit).insertOne({
    restaurantId: dbConfig().restaurantId, entity, entityId, action,
    before: before ?? null, after: after ?? null, actor, at: new Date(),
  })
}

