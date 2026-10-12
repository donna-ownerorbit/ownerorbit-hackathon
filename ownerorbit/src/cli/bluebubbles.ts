import { readFileSync } from 'node:fs'
import { config } from '../config.ts'
import { ping } from '../transport/bluebubbles.ts'

/**
 * Point the BlueBubbles server at this OwnerOrbit server (reads everything from .env.local; never prints secrets).
 *   npm run bluebubbles -- status            ping + list registered webhooks
 *   npm run bluebubbles -- connect [url]     register <url>/messages/inbound?secret=… for new-message
 *                                            (url defaults to the running cloudflared quick tunnel)
 */
const [cmd = 'status', arg] = process.argv.slice(2)
const { url, password, webhookSecret } = config.bluebubbles
if (!url) throw new Error('BLUEBUBBLES_URL is not set in .env.local')
if (!password) throw new Error('BLUEBUBBLES_PASSWORD is not set in .env.local')
const q = `password=${encodeURIComponent(password)}`
const mask = (s: string) => s.replace(/secret=[^&]+/, 'secret=…')

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}${q}`, { ...init, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`BlueBubbles ${path.split('?')[0]} → ${r.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body as { data?: unknown }
}

const p = await ping()
console.log(`BlueBubbles ${url} → ${p.ok ? 'reachable, password OK' : `NOT OK (${'status' in p ? p.status : p.error})`}`)
if (!p.ok) process.exit(1)

const list = async () => ((await api('/api/v1/webhook')).data ?? []) as { id: number; url: string; events: string[] }[]
if (cmd === 'connect') {
  const base = (arg ?? readFileSync('.data/tunnel.log', 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? '').replace(/\/$/, '')
  if (!base) throw new Error('No public URL: pass one, or start cloudflared (log in .data/tunnel.log)')
  if (!webhookSecret) throw new Error('BLUEBUBBLES_WEBHOOK_SECRET is not set — the tunnel is public, so the webhook must be secret-protected')
  const target = `${base}/messages/inbound?secret=${encodeURIComponent(webhookSecret)}`
  // Drop our own stale tunnels (old trycloudflare URLs pointing at /messages/inbound); leave other webhooks alone.
  for (const w of await list()) {
    if (w.url !== target && /trycloudflare\.com\/messages\/inbound\?secret=/.test(w.url)) {
      await api(`/api/v1/webhook/${w.id}`, { method: 'DELETE' }).then(() => console.log(`  removed stale ${mask(w.url)}`), (e) => console.warn('  could not remove', w.id, e.message))
    }
  }
  if (!(await list()).some((w) => w.url === target)) {
    await api('/api/v1/webhook', { method: 'POST', body: JSON.stringify({ url: target, events: ['new-message'] }) })
    console.log(`  registered ${mask(target)}`)
  }
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.ok, () => false)
  console.log(`  ${base}/health from the internet → ${health ? 'OK' : 'NOT reachable'}`)
}
console.log('Webhooks on BlueBubbles:')
for (const w of await list()) console.log(`  #${w.id} ${mask(w.url)} [${w.events.join(', ')}]`)
process.exit(0)
