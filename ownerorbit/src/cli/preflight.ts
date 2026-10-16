import { config } from '../config.ts'
import { SandboxSession } from '../browser/session.ts'
import { SKILLS, jsonSchema } from '../skills/index.ts'
import { evidence } from '../telemetry/evidence.ts'
import { tracingEnabled } from '../telemetry/tracing.ts'
import { llmAvailable } from '../nlu/llm.ts'
import { ping } from '../transport/bluebubbles.ts'
import { agentAvailable } from '../agent/haiku.ts'
import { brain } from '../agent/brain.ts'
import { C, getDb, mongoConfigured } from '../db/mongo.ts'

/**
 * Run before going on stage. Proves every screen the skills drive still has the selectors they
 * rely on (the dashboard is being edited concurrently), plus every integration is wired.
 */
const rows: [string, boolean | 'warn', string][] = []
const ok = (name: string, pass: boolean | 'warn', detail = '') => { rows.push([name, pass, detail]); console.log(`${pass === true ? '✅' : pass === 'warn' ? '⚠️ ' : '❌'} ${name.padEnd(34)} ${detail}`) }

const t = Date.now()
try {
  const r = await fetch(config.sandboxUrl + '/menu/overview', { signal: AbortSignal.timeout(10_000) })
  ok('site reachable', r.ok, `${config.sandboxUrl} → ${r.status}`)
  const h = await fetch(config.sandboxUrl + '/api/health', { signal: AbortSignal.timeout(12_000) }).then((x) => x.json()).catch((e) => ({ error: e.message }))
  ok('dashboard database', h.ok ? true : 'warn', h.ok ? `${h.database} (${h.pingMs}ms)` : `${h.error} → will run isolated`)
} catch (e) { ok('site reachable', false, (e as Error).message) }

const s = new SandboxSession({ profileDir: '.data/preflight-profile', api: 'isolated' })
await s.start()
ok('browser + app boot', true, `${Date.now() - t}ms`)
const snap = await s.readTruth()
ok('ground truth readable', snap.items.length > 0, `${snap.items.length} items · ${snap.categories.length} categories · ${snap.orders.length} orders`)

const page = s.page
const probes: [string, string, string[]][] = [
  ['Menu → Overview', '/menu/overview', ['.overview .search input', '.overview .toolbar button', '.item-row .status-btn', '.menu-header .btn-accepting', '.menu-header .btn-store']],
  ['Item detail panel', `/menu/overview?item=${snap.items[0].id}`, ['.detail .crumb-current', '.detail-scroll > .tf', '.detail-foot button', '.detail button[aria-label="More"]', '.detail-scroll .mod-chip', 'button.add-size', 'button.btn-ai']],
  ['Menu → Categories', '/menu/categories', ['.data-table tbody tr .strong-cell', 'button[aria-label="Move up"]', 'button[aria-label="Edit"]', '.data-table .status-btn']],
  ['Menu → Modifier groups', '/menu/modifier-groups', ['.mod-grid .mod-card .mod-title']],
  ['Orders', `/orders?o=${snap.orders[0].id}`, ['.ticket h2', '.ticket-head .status-pill']],
  ['Reports', '/reports', ['.page-header .seg button', '.stat .stat-value', '.hbars li']],
  ['Home', '/home', ['.stat .stat-label', '.attention li']],
  ['Chargebacks', '/chargeback', ['.data-table tbody tr .strong-cell']],
  ['Schedule', '/schedule', ['.hours-row b', '.hours-row [role="switch"]', '.hours-row input.time']],
]
for (const [name, path, sels] of probes) {
  await s.go(path)
  const missing: string[] = []
  for (const sel of sels) if (!(await page.locator(sel).first().waitFor({ timeout: 4000 }).then(() => true, () => false))) missing.push(sel)
  ok(`selectors: ${name}`, !missing.length, missing.length ? `missing ${missing.join(', ')}` : `${sels.length}/${sels.length}`)
}
await s.close()

let schemas = 0
for (const sk of SKILLS) { try { jsonSchema(sk); schemas++ } catch { /* counted */ } }
ok('skill registry', schemas === SKILLS.length, `${SKILLS.length} skills, ${schemas} tool schemas`)
const bb = await ping()
ok('BlueBubbles', bb.ok ? true : 'warn', bb.ok ? config.bluebubbles.url : `${'error' in bb ? bb.error : bb.status} (CLI/simulator still work)`)
ok('Claude planner', llmAvailable() ? true : 'warn', llmAvailable() ? config.model : 'no ANTHROPIC_API_KEY → grammar-only (all demo lines covered)')
ok('Haiku agent', agentAvailable() ? true : 'warn', agentAvailable() ? `${config.agentModel} (planner ${config.planner})` : 'no ANTHROPIC_API_KEY → grammar only')
if (mongoConfigured()) {
  try {
    const db = await getDb()
    const pb = await brain.playbooks()
    ok('MongoDB inbox', true, `${config.mongo.db}.${C.inbox} · ${await db.collection(C.inbox).countDocuments({ status: { $in: ['queued', 'processing'] } })} waiting`)
    ok('Playbooks (dashboard skills)', pb.length ? true : 'warn', pb.map((p) => `${p.skillId}@v${p.version}`).join(', ') || 'none — open /skills on the dashboard once to seed')
    ok('Principals in MongoDB', true, `${await db.collection(C.principals).countDocuments({ restaurantId: config.restaurantId, active: { $ne: false } })} active`)
  } catch (e) { ok('MongoDB inbox', false, (e as Error).message) }
} else ok('MongoDB inbox', 'warn', 'MONGODB_URI not set → webhook handles messages inline')
ok('Raindrop tracing', tracingEnabled() ? true : 'warn', tracingEnabled() ? 'on' : 'no RAINDROP_WRITE_KEY')
ok('Evidence store', true, evidence.describe())
ok('Owner phone(s)', Object.keys(config.principals).length || mongoConfigured() ? true : 'warn', Object.keys(config.principals).length ? Object.entries(config.principals).map(([k, v]) => `${k.replace(/\d(?=\d{4})/g, '•')}:${v}`).join(', ') : 'OWNERORBIT_PRINCIPALS empty — iMessages will be refused')

const failed = rows.filter((r) => r[1] === false).length
console.log(`\n${failed ? `❌ ${failed} blocking problem(s)` : '✅ Ready for stage'} · ${((Date.now() - t) / 1000).toFixed(1)}s`)
process.exit(failed ? 1 : 0)
