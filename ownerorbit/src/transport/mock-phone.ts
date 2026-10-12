import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config, usesMockBluebubbles } from '../config.ts'
import { C, getDb, normalizeHandle } from '../db/mongo.ts'
import { upsertPrincipal } from '../core/principals.ts'
import { agentAvailable } from '../agent/haiku.ts'
import { bxAvailable } from '../integrations/browser-exec.ts'

/**
 * The demo path when there's no BlueBubbles (or it breaks on stage):
 *
 *   /phone (browser)  ──POST /phone/send──▶  builds a real BlueBubbles "new-message" webhook
 *                                            ──▶ POST /messages/inbound (exact production path)
 *   Donna's reply ──POST /mock-bluebubbles/api/v1/message/text (BlueBubbles REST shape)──▶ mock_imessages
 *   /phone polls /phone/thread and renders the conversation next to the live website.
 *
 * Nothing here is a shortcut: identity, inbox, worker, grammar/Haiku, skills, verification and evals
 * are all the real ones; only Apple's delivery is replaced.
 */

const MOCK = 'mock_imessages'
const chatFor = (phone: string) => `mock;-;${phone}`
const page = () => readFileSync(new URL('./phone.html', import.meta.url), 'utf8')

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString()
  return raw ? JSON.parse(raw) : {}
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

/** Registers the demo number as an owner so the mock phone is authorized (mock mode only). */
export async function ensureDemoPrincipal() {
  await upsertPrincipal({ phone: config.demoPhone, name: 'Demo Owner (mock phone)', role: 'owner' })
}

export async function handleMockRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname

  /* ---------- BlueBubbles REST stand-in (what Donna's transport calls in mock mode) ---------- */
  if (p.startsWith('/mock-bluebubbles/')) {
    if (url.searchParams.get('password') !== 'mock') return json(res, 401, { status: 401, message: 'Unauthorized' }), true
    if (p === '/mock-bluebubbles/api/v1/ping') return json(res, 200, { status: 200, message: 'Ping received!', data: 'pong' }), true
    if (/^\/mock-bluebubbles\/api\/v1\/chat\/[^/]+\/typing$/.test(p)) return json(res, 200, { status: 200, message: 'Success' }), true
    if (p === '/mock-bluebubbles/api/v1/message/text' && req.method === 'POST') {
      const b = (await body(req)) as { chatGuid?: string; message?: string; tempGuid?: string; method?: string }
      if (!b.chatGuid || !b.message) return json(res, 400, { status: 400, message: 'chatGuid and message required' }), true
      const guid = randomUUID()
      const ref = b.tempGuid?.split('#')[0] ?? null
      const db = await getDb()
      await db.collection(MOCK).insertOne({ chat: b.chatGuid, dir: 'out', text: b.message, guid, ref, method: b.method ?? null, at: new Date() })
      console.log(`📱 mock BlueBubbles → ${b.chatGuid}: ${b.message.split('\n')[0].slice(0, 100)}`)
      return json(res, 200, { status: 200, message: 'Message sent!', data: { guid, tempGuid: b.tempGuid, text: b.message, isFromMe: true } }), true
    }
    return json(res, 404, { status: 404, message: 'Not found' }), true
  }

  /* ---------- the demo phone ---------- */
  if (p === '/phone' || p === '/phone/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(page())
    return true
  }
  if (p === '/phone/config') {
    return json(res, 200, {
      phone: config.demoPhone, chat: chatFor(config.demoPhone), site: config.sandboxUrl,
      bluebubbles: usesMockBluebubbles() ? 'mock' : 'real', haiku: agentAvailable() ? config.agentModel : null,
      browserExec: (await bxAvailable()) ? config.browserExecUrl : null, raindrop: !!config.raindropKey,
    }), true
  }
  if (p === '/phone/send' && req.method === 'POST') {
    const { text } = (await body(req)) as { text?: string }
    if (!text?.trim()) return json(res, 400, { error: 'text required' }), true
    const phone = config.demoPhone, chat = chatFor(phone), guid = randomUUID()
    const db = await getDb()
    await db.collection(MOCK).insertOne({ chat, dir: 'in', text: text.trim(), guid, at: new Date() })
    // Exactly what BlueBubbles Server POSTs for a "New Messages" webhook.
    const webhook = { type: 'new-message', data: { guid, text: text.trim(), isFromMe: false, dateCreated: Date.now(), handle: { address: phone, service: 'iMessage' }, chats: [{ guid: chat }], associatedMessageGuid: null } }
    const r = await fetch(`http://127.0.0.1:${config.port}/messages/inbound${config.bluebubbles.webhookSecret ? `?secret=${config.bluebubbles.webhookSecret}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webhook),
    })
    return json(res, r.ok ? 200 : 502, { guid, webhook: r.status }), true
  }
  if (p === '/phone/thread') {
    const chat = chatFor(config.demoPhone)
    const db = await getDb()
    const msgs = await db.collection(MOCK).find({ chat }, { projection: { _id: 0 } }).sort({ at: 1 }).limit(200).toArray()
    const ins = msgs.filter((m) => m.dir === 'in').map((m) => m.guid)
    const docs = await db.collection(C.inbox).find({ messageId: { $in: ins } }, { projection: { _id: 0, messageId: 1, status: 1, planner: 1, ms: 1, results: 1, evals: 1 } }).toArray()
    const byId = new Map(docs.map((d) => [d.messageId, d]))
    return json(res, 200, {
      messages: msgs.map((m) => ({ dir: m.dir, text: m.text, at: m.at, guid: m.guid, ref: m.ref ?? null })),
      runs: Object.fromEntries(ins.map((g) => [g, byId.get(g) ?? { status: 'sent' }])),
    }), true
  }
  if (p === '/phone/clear' && req.method === 'POST') {
    const db = await getDb()
    await db.collection(MOCK).deleteMany({ chat: chatFor(config.demoPhone) })
    await db.collection(C.conversations).deleteMany({ principal: normalizeHandle(config.demoPhone) })
    return json(res, 200, { ok: true }), true
  }
  return false
}
