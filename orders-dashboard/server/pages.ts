import type { Document } from 'mongodb'
import { dbConfig, getDb } from './db.js'
import { arr, audit, bool, HttpError, obj, pick, str, type Rule } from './shared.js'
import type { ApiResponse } from './api.js'

// Public website pages (e.g. /p/catering). Append-only like skills: every publish inserts a new
// version; the latest version is what /p/:slug shows. Agents publish through PUT /api/pages/:slug.

const COLL = 'site_pages'
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/

const href: Rule = (v) => {
  const s = str(500)(v) as string
  if (!/^(https?:\/\/|\/|mailto:|tel:|sms:)/.test(s)) throw new HttpError(400, 'invalid link')
  return s
}
const PAGE: Record<string, Rule> = {
  title: str(120), headline: str(200), intro: str(2000),
  sections: arr(obj({ heading: str(120), body: str(3000) }), 12),
  highlights: arr(str(160), 12),
  cta: obj({ label: str(60), href }),
  contact: str(300), published: bool, note: str(200), updatedBy: str(80),
}

let ready: Promise<unknown> | null = null
const ensure = () => (ready ??= getDb().then((db) => db.collection(COLL).createIndex({ restaurantId: 1, slug: 1, version: -1 }, { unique: true })).catch((e) => { ready = null; throw e }))

const view = (d: Document | null) => {
  if (!d) return null
  const { _id, restaurantId, ...rest } = d
  void _id; void restaurantId
  return rest
}

export async function handlePages(method: string, slug: string | undefined, body: unknown): Promise<ApiResponse> {
  await ensure()
  const db = await getDb()
  const rid = dbConfig().restaurantId
  if (slug !== undefined && !SLUG.test(slug)) throw new HttpError(400, 'invalid slug (lowercase letters, numbers, dashes)')

  if (method === 'GET' && !slug) {
    const rows = await db.collection(COLL).aggregate([
      { $match: { restaurantId: rid } },
      { $sort: { slug: 1, version: -1 } },
      { $group: { _id: '$slug', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $project: { _id: 0, slug: 1, title: 1, version: 1, published: 1, updatedAt: 1, updatedBy: 1 } },
      { $sort: { updatedAt: -1 } },
    ]).toArray()
    return { status: 200, json: { pages: rows } }
  }
  if (!slug) throw new HttpError(404, 'no such endpoint')

  const latest = await db.collection(COLL).find({ restaurantId: rid, slug }).sort({ version: -1 }).limit(1).next()
  if (method === 'GET') {
    if (!latest) throw new HttpError(404, 'page not found')
    return { status: 200, json: { page: view(latest) } }
  }

  if (method === 'PUT') {
    const p = pick(body, PAGE) as Record<string, unknown>
    const next = { ...(view(latest) ?? {}), ...p }
    if (!next.title || !next.headline) throw new HttpError(400, 'title and headline required')
    const version = ((latest?.version as number) ?? 0) + 1
    const doc: Record<string, unknown> = {
      ...next, restaurantId: rid, slug, version, published: next.published ?? true,
      updatedBy: (p.updatedBy as string) ?? 'dashboard', note: (p.note as string) ?? (latest ? 'Updated' : 'Created'), updatedAt: new Date(),
    }
    delete doc.createdAt
    try {
      await db.collection(COLL).insertOne(doc)
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'page changed concurrently — retry')
      throw e
    }
    await audit('site_page', slug, latest ? 'version' : 'create', latest && { version: latest.version }, { version, title: next.title }, String(doc.updatedBy))
    return { status: latest ? 200 : 201, json: { ok: true, slug, version, path: `/p/${slug}` } }
  }
  throw new HttpError(404, 'no such endpoint')
}
