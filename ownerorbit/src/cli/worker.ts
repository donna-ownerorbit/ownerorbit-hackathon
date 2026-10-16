import { config } from '../config.ts'
import { OwnerOrbit } from '../core/orbit.ts'
import { SandboxSession } from '../browser/session.ts'
import { InboxWorker } from '../inbox/worker.ts'
import { agentAvailable } from '../agent/haiku.ts'
import { flushTracing } from '../telemetry/tracing.ts'

/** Inbox worker without the HTTP server — for when another process writes iMessages into MongoDB. */
const orbit = new OwnerOrbit(new SandboxSession({ stage: process.argv.includes('--stage') }))
await orbit.session.start()
const worker = new InboxWorker(orbit)
await worker.start()
console.log(`OwnerOrbit inbox worker ${worker.id} · ${config.mongo.db}.inbound_messages · agent ${agentAvailable() ? config.agentModel : 'off (no ANTHROPIC_API_KEY)'} · sandbox ${orbit.session.url}`)
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await worker.stop(); await flushTracing(); await orbit.session.close().catch(() => undefined); process.exit(0) })
