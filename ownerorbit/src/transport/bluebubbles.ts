import { randomUUID } from 'node:crypto'
import { config, usesMockBluebubbles } from '../config.ts'

/** Subset of the BlueBubbles server webhook payload we rely on. */
export interface BBWebhook {
  type: string
  data?: {
    guid?: string
    text?: string | null
    isFromMe?: boolean
    handle?: { address?: string } | null
    chats?: { guid?: string }[]
    associatedMessageGuid?: string | null
  }
}

export interface BBInbound { messageId: string; from: string; chat: string; text: string }

/** Normalise a webhook into a command, or null for anything we should ignore. */
export function parseWebhook(body: BBWebhook): BBInbound | null {
  if (body?.type !== 'new-message' || !body.data) return null
  const d = body.data
  if (d.isFromMe) return null // Donna's own outgoing messages echo back as webhooks
  if (d.associatedMessageGuid) return null // tapbacks / reactions
  const text = (d.text ?? '').replace(/￼/g, '').trim()
  const from = d.handle?.address ?? ''
  const chat = d.chats?.[0]?.guid ?? (from ? `iMessage;-;${from}` : '')
  if (!text || !from || !chat) return null
  return { messageId: d.guid ?? randomUUID(), from, chat, text }
}

const method = () => (process.env.BLUEBUBBLES_PRIVATE_API === 'true' ? 'private-api' : 'apple-script')

/** Real BlueBubbles server, or the stand-in this process serves at /mock-bluebubbles (same REST shape). */
export function bbTarget(chat?: string | null) {
  return usesMockBluebubbles(chat)
    ? { url: `http://127.0.0.1:${config.port}/mock-bluebubbles`, password: 'mock', mock: true }
    : { url: config.bluebubbles.url, password: config.bluebubbles.password, mock: false }
}

async function bb(path: string, body?: unknown, chat?: string | null) {
  const { url, password } = bbTarget(chat)
  if (!url) throw new Error('BLUEBUBBLES_URL not set')
  const res = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}password=${encodeURIComponent(password)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`BlueBubbles ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json().catch(() => ({}))
}

/** `ref` (the inbound message id) rides in tempGuid so a reply can be traced back to what triggered it. */
export async function sendText(chatGuid: string, message: string, ref?: string) {
  // iMessage handles long texts fine, but keep each bubble readable.
  for (const [i, chunk] of chunks(message, 1800).entries()) await bb('/api/v1/message/text', { chatGuid, tempGuid: ref ? `${ref}#${i}` : randomUUID(), message: chunk, method: method() }, chatGuid)
}

/** "Donna is typing…" while a skill runs (needs the BlueBubbles Private API helper). */
export async function typing(chatGuid: string, on: boolean) {
  if (method() !== 'private-api') return
  try { await bb(`/api/v1/chat/${encodeURIComponent(chatGuid)}/typing`, undefined, chatGuid) } catch { /* optional */ }
  void on
}

function chunks(s: string, n: number) {
  const out: string[] = []
  let cur = ''
  for (const line of s.split('\n')) {
    if ((cur + '\n' + line).length > n && cur) { out.push(cur); cur = line } else cur = cur ? cur + '\n' + line : line
  }
  if (cur) out.push(cur)
  return out
}

export async function ping() {
  const { url, password, mock } = bbTarget()
  if (mock) return { ok: true, mode: 'mock', url }
  if (!url) return { ok: false, error: 'BLUEBUBBLES_URL not set' }
  try {
    const r = await fetch(`${url}/api/v1/ping?password=${encodeURIComponent(password)}`, { signal: AbortSignal.timeout(5000) })
    return { ok: r.ok, status: r.status }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}
