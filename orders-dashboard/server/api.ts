import type { AnyBulkWriteOperation, Document } from 'mongodb'
import { COLLECTIONS as C, DbNotConfigured, dbConfig, getDb } from './db.js'
import { arr, audit, CATEGORY, HttpError, ID, ITEM, MODGROUP, oneOf, ORDER_STATUSES, pick, RESTAURANT, str, strip } from './shared.js'
import { buildSeed, MODIFIER_GROUPS, STORES } from '../src/data.js'
import { generateOrders } from '../src/orders.js'
import { handleSkills } from './skills.js'
import { handlePages } from './pages.js'

export interface ApiRequest { method: string; path: string; body: unknown }
export interface ApiResponse { status: number; json: unknown }

let indexesReady: Promise<unknown> | null = null
function ensureIndexes() {
  if (!indexesReady) {
    indexesReady = getDb().then((db) => Promise.all([
      db.collection(C.categories).createIndex({ restaurantId: 1, id: 1 }, { unique: true }),
      db.collection(C.items).createIndex({ restaurantId: 1, id: 1 }, { unique: true }),
      db.collection(C.items).createIndex({ restaurantId: 1, categoryId: 1, sort: 1 }),
      db.collection(C.modifierGroups).createIndex({ restaurantId: 1, id: 1 }, { unique: true }),
      db.collection(C.orders).createIndex({ restaurantId: 1, id: 1 }, { unique: true }),
      db.collection(C.orders).createIndex({ restaurantId: 1, placedAt: -1 }),
      db.collection(C.audit).createIndex({ restaurantId: 1, at: -1 }),
    ])).catch((e) => { indexesReady = null; throw e })
  }
  return indexesReady
}

/** Inserts the starting menu only where records don't exist yet. Never overwrites. */
async function seedIfNeeded() {
  const db = await getDb()
  const rid = dbConfig().restaurantId
  const existing = await db.collection(C.restaurants).findOne({ _id: rid as never })
  if (existing?.seededAt) return
  const now = new Date()
  const seed = buildSeed()
  const upsert = (docs: Document[]): AnyBulkWriteOperation[] => docs.map((d, i) => ({
    updateOne: { filter: { restaurantId: rid, id: d.id }, update: { $setOnInsert: { ...d, restaurantId: rid, sort: i, createdAt: now, updatedAt: now } }, upsert: true },
  }))
  await db.collection(C.categories).bulkWrite(upsert(seed.categories as unknown as Document[]), { ordered: false })
  await db.collection(C.items).bulkWrite(upsert(seed.items as unknown as Document[]), { ordered: false })
  await db.collection(C.modifierGroups).bulkWrite(upsert(MODIFIER_GROUPS as unknown as Document[]), { ordered: false })
  await db.collection(C.orders).bulkWrite(upsert(generateOrders(seed.items).map((o) => ({ ...o, storeId: STORES[0].id, statusHistory: [{ status: o.status, at: new Date(o.placedAt) }] }))), { ordered: false })
  await db.collection(C.restaurants).updateOne(
    { _id: rid as never },
    {
      $setOnInsert: { name: 'Falafel Flare', stores: STORES, storeId: STORES[0].id, accepting: true, pausedUntil: null, menuSyncedAt: Date.now() - 26 * 3600e3, createdAt: now },
      $set: { seededAt: now },
    },
    { upsert: true },
  )
  await audit('restaurant', rid, 'seed', null, { categories: seed.categories.length, items: seed.items.length })
}

/* ---------------- router ---------------- */
export async function handle(req: ApiRequest): Promise<ApiResponse> {
  try {
    const parts = req.path.replace(/^\/?api\/?/, '').split('/').filter(Boolean)
    const [resource, id] = parts
    const m = req.method.toUpperCase()
    const { restaurantId: rid, name } = dbConfig()

    if (resource === 'health') {
      const t = Date.now()
      const db = await getDb()
      await db.command({ ping: 1 })
      const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort()
      return { status: 200, json: { ok: true, database: name, pingMs: Date.now() - t, collections } }
    }

    await ensureIndexes()
    const db = await getDb()
    if (id !== undefined && !ID.test(id)) throw new HttpError(400, 'invalid id')
    if (resource === 'skills' || resource === 'approvals') return await handleSkills(m, parts, req.body)
    if (resource === 'pages') return await handlePages(m, id, req.body)
    const scope = (extra: Document = {}) => ({ restaurantId: rid, ...extra })

    if (resource === 'state' && m === 'GET') {
      await seedIfNeeded()
      const [restaurant, categories, items, modifierGroups, orders] = await Promise.all([
        db.collection(C.restaurants).findOne({ _id: rid as never }),
        db.collection(C.categories).find(scope()).sort({ sort: 1 }).toArray(),
        db.collection(C.items).find(scope()).sort({ sort: 1 }).toArray(),
        db.collection(C.modifierGroups).find(scope()).sort({ sort: 1 }).toArray(),
        db.collection(C.orders).find(scope(), { projection: { statusHistory: 0 } }).sort({ placedAt: -1 }).limit(500).toArray(),
      ])
      return {
        status: 200,
        json: {
          restaurant: { storeId: restaurant?.storeId, accepting: restaurant?.accepting, pausedUntil: restaurant?.pausedUntil ?? null, menuSyncedAt: restaurant?.menuSyncedAt },
          categories: categories.map(strip), items: items.map(strip), modifierGroups: modifierGroups.map(strip), orders: orders.map(strip),
          database: name,
        },
      }
    }

    if (resource === 'restaurant' && m === 'PATCH') {
      const patch = pick(req.body, RESTAURANT)
      const before = await db.collection(C.restaurants).findOneAndUpdate({ _id: rid as never }, { $set: { ...patch, updatedAt: new Date() } })
      await audit('restaurant', rid, 'update', before && Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), patch)
      return { status: 200, json: { ok: true } }
    }

    if (resource === 'items' || resource === 'categories' || resource === 'modifier-groups') {
      const coll = db.collection(resource === 'items' ? C.items : resource === 'categories' ? C.categories : C.modifierGroups)
      const shape = resource === 'items' ? ITEM : resource === 'categories' ? CATEGORY : MODGROUP
      const entity = resource === 'items' ? 'menu_item' : resource === 'categories' ? 'menu_category' : 'modifier_group'

      if (m === 'POST' && !id) {
        const bodyId = (req.body as { id?: unknown })?.id
        if (typeof bodyId !== 'string' || !ID.test(bodyId)) throw new HttpError(400, 'id required')
        const doc = pick(req.body, shape)
        if (!doc.name) throw new HttpError(400, 'name required')
        if (resource === 'items' && !(await db.collection(C.categories).findOne(scope({ id: doc.categoryId })))) throw new HttpError(400, 'unknown category')
        const last = await coll.find(scope()).sort({ sort: -1 }).limit(1).next()
        const now = new Date()
        try {
          await coll.insertOne({ ...doc, id: bodyId, restaurantId: rid, sort: (last?.sort ?? -1) + 1, createdAt: now, updatedAt: now })
        } catch (e) {
          if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'already exists')
          throw e
        }
        await audit(entity, bodyId, 'create', null, doc)
        return { status: 201, json: { ok: true } }
      }
      if (m === 'PATCH' && id) {
        const patch = pick(req.body, shape)
        if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update')
        const before = await coll.findOneAndUpdate(scope({ id }), { $set: { ...patch, updatedAt: new Date() } })
        if (!before) throw new HttpError(404, 'not found')
        await audit(entity, id, 'update', Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), patch)
        return { status: 200, json: { ok: true } }
      }
      if (m === 'PUT' && id && resource === 'modifier-groups') {
        const doc = pick(req.body, shape)
        const before = await coll.findOneAndUpdate(scope({ id }), {
          $set: { ...doc, updatedAt: new Date() },
          $setOnInsert: { id, restaurantId: rid, sort: Date.now(), createdAt: new Date() },
        }, { upsert: true })
        await audit(entity, id, before ? 'update' : 'create', strip(before), doc)
        return { status: 200, json: { ok: true } }
      }
      if (m === 'DELETE' && id) {
        const before = await coll.findOneAndDelete(scope({ id }))
        if (!before) throw new HttpError(404, 'not found')
        let removedItems = 0
        if (resource === 'categories') removedItems = (await db.collection(C.items).deleteMany(scope({ categoryId: id }))).deletedCount
        await audit(entity, id, 'delete', strip(before), removedItems ? { removedItems } : null)
        return { status: 200, json: { ok: true } }
      }
      if (m === 'PUT' && resource === 'categories' && id === 'order') {
        const ids = arr(str(100), 200)((req.body as { ids?: unknown })?.ids) as string[]
        await coll.bulkWrite(ids.map((cid, i) => ({ updateOne: { filter: scope({ id: cid }), update: { $set: { sort: i } } } })))
        await audit(entity, 'order', 'reorder', null, { ids })
        return { status: 200, json: { ok: true } }
      }
    }

    if (resource === 'orders' && m === 'PATCH' && id) {
      const { status } = pick(req.body, { status: oneOf(ORDER_STATUSES) }) as { status: string }
      const before = await db.collection(C.orders).findOneAndUpdate(scope({ id }), {
        $set: { status, updatedAt: new Date() }, $push: { statusHistory: { status, at: new Date() } } as never,
      })
      if (!before) throw new HttpError(404, 'not found')
      await audit('order', id, 'status', { status: before.status }, { status })
      return { status: 200, json: { ok: true } }
    }

    if (resource === 'audit' && m === 'GET') {
      const rows = await db.collection(C.audit).find(scope(), { projection: { _id: 0, restaurantId: 0 } }).sort({ at: -1 }).limit(100).toArray()
      return { status: 200, json: { rows } }
    }

    throw new HttpError(404, 'no such endpoint')
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } }
    if (e instanceof DbNotConfigured) return { status: 503, json: { error: 'database not configured' } }
    const msg = (e as Error).message ?? ''
    console.error('[api]', (e as Error).name, msg.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, '[uri]'))
    const status = /auth|bad auth/i.test(msg) ? 502 : /timed out|ENOTFOUND|ECONNREFUSED|Server selection/i.test(msg) ? 504 : 500
    return { status, json: { error: status === 502 ? 'database authentication failed' : status === 504 ? 'database unreachable (check Atlas network access)' : 'server error' } }
  }
}
