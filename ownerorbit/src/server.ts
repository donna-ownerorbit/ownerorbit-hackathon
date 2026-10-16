import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { config, usesMockBluebubbles } from './config.ts'
import { OwnerOrbit } from './core/orbit.ts'
import { SandboxSession } from './browser/session.ts'
import { jsonSchema, SKILLS } from './skills/index.ts'
import { evidence } from './telemetry/evidence.ts'
import { flushTracing, tracingEnabled } from './telemetry/tracing.ts'
import { llmAvailable } from './nlu/llm.ts'
import { parseWebhook, ping, sendText, typing, type BBWebhook } from './transport/bluebubbles.ts'
import { enqueue, InboxWorker } from './inbox/worker.ts'
import { C, getDb, mongoConfigured } from './db/mongo.ts'
import { agentAvailable } from './agent/haiku.ts'
import { ensureDemoPrincipal, handleMockRoutes } from './transport/mock-phone.ts'
import { bxAvailable } from './integrations/browser-exec.ts'
import { githubConfigured, validSignature } from './github/sync.ts'

const stage = process.argv.includes('--stage') || process.env.STAGE === '1'
const orbit = new OwnerOrbit(new SandboxSession({ stage }))
// With MongoDB configured, every iMessage goes through the durable inbox (inbound_messages) and the
// worker; without it, the webhook falls back to handling messages inline.
const worker = config.inbox && mongoConfigured() ? new InboxWorker(orbit) : null

async function rawBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString()
}
async function body(req: IncomingMessage): Promise<unknown> {
  const raw = await rawBody(req)
  return raw ? JSON.parse(raw) : {}
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data, null, 1))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    // Mock iMessage: BlueBubbles REST stand-in + the /phone demo UI (needs MongoDB).
    if ((url.pathname.startsWith('/mock-bluebubbles/') || url.pathname.startsWith('/phone')) && mongoConfigured() && await handleMockRoutes(req, res, url)) return
    // BlueBubbles → Donna
    if (req.method === 'POST' && url.pathname === '/messages/inbound') {
      if (config.bluebubbles.webhookSecret && url.searchParams.get('secret') !== config.bluebubbles.webhookSecret) return json(res, 401, { error: 'bad secret' })
      const msg = parseWebhook((await body(req)) as BBWebhook)
      if (msg && worker) {
        const q = await enqueue({ ...msg, channel: 'imessage' })
        return json(res, 200, { ok: true, accepted: true, ...q })
      }
      json(res, 200, { ok: true, accepted: !!msg }) // ack fast; BlueBubbles retries slow webhooks
      if (!msg) return
      console.log(`📨 ${msg.from}: ${msg.text}`)
      await typing(msg.chat, true)
      const out = await orbit.handle({ from: msg.from, text: msg.text, messageId: msg.messageId, chat: msg.chat })
      if (out.ignored || !out.reply) return
      console.log(`💬 → ${out.reply.replace(/\n/g, ' ⏎ ')}  [${out.planner}, ${out.ms}ms]`)
      await sendText(msg.chat, out.reply).catch((e) => console.error('[bluebubbles] send failed:', e.message))
      return
    }
    // GitHub push webhook → pull now (polling covers it otherwise). Signed with GITHUB_WEBHOOK_SECRET.
    if (req.method === 'POST' && url.pathname === '/github/webhook') {
      const raw = await rawBody(req)
      if (!validSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, config.github.webhookSecret)) return json(res, 401, { error: 'bad signature' })
      if (!worker || !githubConfigured()) return json(res, 400, { error: 'GitHub sync needs GITHUB_REPO and the inbox worker' })
      json(res, 202, { ok: true })
      void worker.pullGithub()
      return
    }
    if (url.pathname === '/github') {
      if (!mongoConfigured()) return json(res, 400, { error: 'MONGODB_URI not set' })
      if (req.method === 'POST') return json(res, 200, worker ? await worker.pullGithub() : { error: 'inbox worker off' })
      const db = await getDb()
      return json(res, 200, await db.collection(C.githubCommits).find({ repo: config.github.repo }, { projection: { _id: 0, files: 0, text: 0 } }).sort({ committedAt: -1 }).limit(20).toArray())
    }
    // Local simulator (same pipeline, no iMessage)
    if (req.method === 'POST' && url.pathname === '/simulate') {
      const b = (await body(req)) as { from?: string; text?: string; inbox?: boolean }
      if (!b.text) return json(res, 400, { error: 'text required' })
      // inbox: true → exactly the iMessage path (Mongo inbox → worker), waits for the result.
      if (b.inbox) {
        if (!worker) return json(res, 400, { error: 'inbox disabled (needs MONGODB_URI and OWNERORBIT_INBOX!=off)' })
        if (!b.from) return json(res, 400, { error: 'from (phone) required for inbox simulation' })
        const { messageId } = await enqueue({ from: b.from, text: b.text, channel: 'simulator' })
        const db = await getDb()
        for (const t0 = Date.now(); Date.now() - t0 < 180_000; await new Promise((r) => setTimeout(r, 500))) {
          const doc = await db.collection(C.inbox).findOne({ messageId }, { projection: { _id: 0 } })
          if (doc && ['done', 'ignored', 'failed'].includes(doc.status)) return json(res, 200, doc)
        }
        return json(res, 202, { messageId, status: 'still processing' })
      }
      return json(res, 200, await orbit.handle({ from: b.from ?? 'simulator', text: b.text, trusted: !b.from }))
    }
    if (url.pathname === '/inbox') {
      if (!mongoConfigured()) return json(res, 400, { error: 'MONGODB_URI not set' })
      const db = await getDb()
      return json(res, 200, await db.collection(C.inbox).find({}, { projection: { _id: 0 } }).sort({ _id: -1 }).limit(Number(url.searchParams.get('limit') ?? 25)).toArray())
    }
    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true, sandbox: orbit.session.url, apiMode: orbit.session.apiMode, stage, skills: SKILLS.length,
        evidence: evidence.describe(), raindrop: tracingEnabled(), planner: config.planner, claude: llmAvailable(), agent: agentAvailable() ? config.agentModel : null, inbox: worker ? { worker: worker.id, processed: worker.processed } : 'off', github: githubConfigured() ? `${config.github.repo}@${config.github.branch}` : 'off', bluebubbles: await ping(), browserExec: config.browserExecUrl ? { url: config.browserExecUrl, up: await bxAvailable() } : 'off',
      })
    }
    if (url.pathname === '/skills') return json(res, 200, SKILLS.map((s) => ({ id: s.id, title: s.title, risk: s.risk, minRole: s.minRole, description: s.description, examples: s.examples, input: jsonSchema(s) })))
    if (url.pathname === '/actions') return json(res, 200, await evidence.recent(Number(url.searchParams.get('limit') ?? 25)))
    if (url.pathname.startsWith('/evidence/')) {
      const p = normalize(join(config.dataDir, url.pathname.slice(1)))
      if (!p.startsWith(join(config.dataDir, 'evidence')) || !existsSync(p)) return json(res, 404, { error: 'not found' })
      res.writeHead(200, { 'Content-Type': p.endsWith('.png') ? 'image/png' : 'application/zip' })
      return void createReadStream(p).pipe(res)
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: (e as Error).message })
  }
})

server.listen(config.port, async () => {
  console.log(`OwnerOrbit core on :${config.port}${stage ? ' (STAGE MODE)' : ''}`)
  console.log(`  BlueBubbles webhook → POST http://<this-host>:${config.port}/messages/inbound${config.bluebubbles.webhookSecret ? '?secret=…' : ''}`)
  await orbit.session.start()
  if (mongoConfigured()) await ensureDemoPrincipal().catch((e) => console.warn('demo principal:', e.message))
  if (worker) await worker.start().then(() => console.log(`  inbox worker ${worker.id} watching ${config.mongo.db}.${C.inbox}`), (e) => console.error('  inbox worker failed to start:', e.message))
  console.log(`  BlueBubbles ${usesMockBluebubbles() ? 'MOCK (stand-in at /mock-bluebubbles)' : config.bluebubbles.url} · browser-exec ${config.browserExecUrl ? ((await bxAvailable()) ? 'up ' + config.browserExecUrl : 'DOWN (built-in skills)') : 'off'}`)
  if (mongoConfigured()) console.log(`  📱 demo phone → http://localhost:${config.port}/phone   (texts from ${config.demoPhone})`)
  console.log(`  sandbox ${orbit.session.url} · api ${orbit.session.apiMode} · mode ${await orbit.session.mode()} · ${SKILLS.length} skills · evidence ${evidence.describe()} · raindrop ${tracingEnabled() ? 'on' : 'off'} · claude ${llmAvailable() ? 'on' : 'off'}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await worker?.stop(); await flushTracing(); await orbit.session.close().catch(() => undefined); process.exit(0) })
