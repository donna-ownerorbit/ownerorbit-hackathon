/**
 * Scenario evals: the whole OwnerOrbit loop against an isolated dashboard, with real Claude Haiku and
 * real MongoDB, in its own tenant (falafel-flare-evals) so production data is never touched.
 *
 *   npm run evals                     core + security + agent + longhorizon + channels
 *   npm run evals -- --tier=core      one tier (core runs with no model calls)
 *   npm run evals -- --only=sec.      scenario ids starting with a prefix
 *   npm run evals -- --repeat=3       run every Haiku scenario 3× (all must pass)
 *   npm run evals -- --live           also publish/unpublish a real page on the Vercel site
 *   npm run evals -- --keep           don't delete the eval tenant's MongoDB data afterwards
 *
 * Writes .data/evals/<timestamp>.json and an `eval_runs` document; exit code 1 on any failure.
 */
const EVAL_TENANT = 'falafel-flare-evals'
const args = process.argv.slice(2)
const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
// Must be set before config loads: isolate everything that could reach production.
Object.assign(process.env, {
  RESTAURANT_ID: EVAL_TENANT, SANDBOX_API: args.includes('--live') ? 'auto' : 'isolated', BROWSER_EXEC_URL: '', BLUEBUBBLES_URL: '',
  HARNESS_BRIDGE: 'fallback', HARNESS_EVENTS_COLLECTION: 'evals_audit_events', GITHUB_REPO: 'ownerorbit-evals/briefs', GITHUB_POLL_MS: '0',
  GITHUB_PRINCIPALS: '{}', OWNERORBIT_PROFILE: '.data/evals-profile', REPLY_TO_UNKNOWN: 'false',
})

const { rmSync, mkdirSync, writeFileSync } = await import('node:fs')
const { config } = await import('../config.ts')
const { PEOPLE, SCENARIOS, judge } = await import('../../test/scenarios.ts')
const { OwnerOrbit } = await import('../core/orbit.ts')
const { SandboxSession } = await import('../browser/session.ts')
const { InboxWorker, enqueue } = await import('../inbox/worker.ts')
const { GitHubSync } = await import('../github/sync.ts')
const { C, getDb, normalizeHandle } = await import('../db/mongo.ts')
const { agentAvailable } = await import('../agent/haiku.ts')
type Scenario = (typeof SCENARIOS)[number]

const live = args.includes('--live')
const tier = flag('tier')
const only = flag('only')
const repeatAll = Number(flag('repeat') ?? 0)
config.principals = { [PEOPLE.owner]: 'owner', [PEOPLE.manager]: 'manager', [PEOPLE.staff]: 'staff' }

const db = await getDb()
const PHONES = Object.values(PEOPLE).map(normalizeHandle)
const TENANT_COLLS = [C.inbox, C.outbox, C.objectives, C.tasks, C.followups, C.handoffs, C.memory, C.runs, C.approvals, C.githubCommits, C.playbooks, C.principals]
async function wipe() {
  for (const k of TENANT_COLLS) await db.collection(k).deleteMany({ restaurantId: EVAL_TENANT })
  await db.collection(C.inbox).deleteMany({ from: { $in: Object.values(PEOPLE) } })
  await db.collection(C.outbox).deleteMany({ to: { $in: Object.values(PEOPLE) } })
  await db.collection('agent_actions').deleteMany({ principal: { $in: PHONES } })
  await db.collection('agent_messages').deleteMany({ principal: { $in: PHONES } })
  await db.collection('users').deleteMany({ tenantId: 'tenant_evals' })
  await db.collection('memberships').deleteMany({ tenantId: 'tenant_evals' })
  await db.collection('evals_audit_events').deleteMany({})
  await db.collection(C.conversations).deleteMany({ _id: { $regex: `^${EVAL_TENANT}:` } as never })
  await db.collection('bridge_state').deleteMany({ _id: { $regex: `^harness:${EVAL_TENANT}:` } as never })
}
await wipe()
// The eval tenant gets the same playbooks production uses right now (latest enabled version of each).
const books = await db.collection(C.playbooks).aggregate([
  { $match: { restaurantId: 'falafel-flare' } }, { $sort: { skillId: 1, version: -1 } },
  { $group: { _id: '$skillId', doc: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$doc' } },
]).toArray()
if (books.length) await db.collection(C.playbooks).insertMany(books.map(({ _id, ...b }) => { void _id; return { ...b, restaurantId: EVAL_TENANT } }))

const selected = SCENARIOS.filter((s) => (s.tier !== 'live' || live) && (!tier || s.tier === tier) && (!only || s.id.startsWith(only)))
  .filter((s) => agentAvailable() || ['core', 'security', 'channels'].includes(s.tier))
let orbit = new OwnerOrbit(new SandboxSession({ api: live ? 'live' : 'isolated', profileDir: '.data/evals-profile' }))
rmSync('.data/evals-profile', { recursive: true, force: true })
await orbit.session.start()
let worker: InstanceType<typeof InboxWorker> | null = null

interface StepLog { text: string; from: string; planner: string; ms: number; reply: string; skills: string[]; evals: { name: string; pass: boolean }[]; failures: string[] }
interface RunLog { id: string; tier: string; title: string; run: number; pass: boolean; ms: number; steps: StepLog[]; error?: string }
const runs: RunLog[] = []
let seq = 0

const awaiting = (from: string) => (orbit as unknown as { memory: { get(id: string): { pending?: { kind: string } | null } } }).memory.get(normalizeHandle(from)).pending?.kind === 'confirm'

/** Every scenario run starts from scratch: fresh dashboard copy, no conversation, empty brain (playbooks kept). */
async function reset() {
  for (const k of TENANT_COLLS.filter((x) => x !== C.playbooks && x !== C.principals)) await db.collection(k).deleteMany({ restaurantId: EVAL_TENANT })
  await db.collection(C.conversations).deleteMany({ _id: { $regex: `^${EVAL_TENANT}:` } as never })
  await orbit.session.close()
  rmSync('.data/evals-profile', { recursive: true, force: true })
  orbit = new OwnerOrbit(new SandboxSession({ api: live ? 'live' : 'isolated', profileDir: '.data/evals-profile' }))
  await orbit.session.start()
}

async function runSteps(s: Scenario, run: number): Promise<RunLog> {
  await reset()
  const t0 = Date.now()
  const since = new Date()
  const log: RunLog = { id: s.id, tier: s.tier, title: s.title, run, pass: true, ms: 0, steps: [] }
  for (const [i, st] of (s.steps ?? []).entries()) {
    if (s.freshBefore?.includes(i)) {
      // New process-equivalent: no in-memory conversation; only MongoDB carries context.
      const session = orbit.session
      orbit = new OwnerOrbit(session)
    }
    const from = PEOPLE[st.from ?? 'owner']
    const messageId = st.messageId ? `${s.id}:${run}:${st.messageId}` : `eval:${s.id}:${run}:${++seq}`
    const out = await orbit.handle({ from, text: st.text, messageId, chat: `evals;-;${from}` })
    const failures = judge(out, st.expect, awaiting(from), st.allowEvalFail)
    if (st.expect.mongo) { const m = await st.expect.mongo(db, { rid: EVAL_TENANT, since }); if (m) failures.push(m) }
    log.steps.push({ text: st.text, from: st.from ?? 'owner', planner: out.planner, ms: out.ms, reply: out.reply, skills: out.results.map((r) => `${r.step.skill}:${r.outcome}${r.verification ? (r.verification.ok ? '✓' : '✗') : ''}`), evals: (out.evals ?? []).map((e) => ({ name: e.name, pass: e.pass })), failures })
    if (failures.length) { log.pass = false; break }
  }
  log.ms = Date.now() - t0
  return log
}

const wait = async <T>(fn: () => Promise<T | null | undefined>, ms = 120_000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 750))) { const v = await fn(); if (v) return v }
  return null
}
const inboxDone = (messageId: string) => wait(() => db.collection(C.inbox).findOne({ messageId, status: { $in: ['done', 'failed', 'ignored'] } }))

async function runChannel(s: Scenario, run: number): Promise<RunLog> {
  const t0 = Date.now()
  const log: RunLog = { id: s.id, tier: s.tier, title: s.title, run, pass: true, ms: 0, steps: [] }
  const step = (text: string, d: { planner?: string; reply?: string; results?: { skill: string; outcome: string; verified: boolean | null }[]; evals?: { name: string; pass: boolean }[] } | null, failures: string[]) => {
    if (!d) failures.push('timed out')
    log.steps.push({ text, from: 'owner', planner: d?.planner ?? '-', ms: 0, reply: d?.reply ?? '', skills: (d?.results ?? []).map((r) => `${r.skill}:${r.outcome}${r.verified ? '✓' : ''}`), evals: d?.evals ?? [], failures })
    if (failures.length) log.pass = false
  }
  const verifiedAvail = (d: { results?: { skill: string; outcome: string; verified: boolean | null }[] } | null) => !!d?.results?.some((r) => r.skill === 'menu.item.set_availability' && r.outcome === 'done' && r.verified)
  const evalsOk = (d: { evals?: { name: string; pass: boolean }[] } | null) => (d?.evals ?? []).filter((e) => !e.pass).map((e) => `eval ${e.name} failed`)

  if (s.custom === 'inbox') {
    const { messageId } = await enqueue({ from: PEOPLE.owner, text: '86 the fried calamari', channel: 'evals' })
    const d = await inboxDone(messageId)
    step('86 the fried calamari (via inbound_messages)', d as never, [...(verifiedAvail(d as never) ? [] : ['availability not verified']), ...evalsOk(d as never), ...(d && !(d as { evals?: unknown[] }).evals?.length ? ['no evals stored on the inbox doc'] : [])])
    const { messageId: m2 } = await enqueue({ from: PEOPLE.owner, text: 'calamari is back', channel: 'evals' })
    step('calamari is back (via inbound_messages)', (await inboxDone(m2)) as never, [])
  }
  if (s.custom === 'github') {
    const sha = `e7a1${String(run).padStart(4, '0')}${Date.now().toString(16)}`.padEnd(40, '0').slice(0, 40)
    const text = 'we are out of onion rings for today'
    const b64 = Buffer.from(text).toString('base64')
    const fake = (async (url: string, init?: RequestInit) => {
      const p = url.replace('https://api.github.com/repos/ownerorbit-evals/briefs', '')
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (init?.method === 'PUT') return ok({ content: { path: p.split('?')[0].replace('/contents/', '') }, commit: { sha: 'f'.repeat(40), html_url: 'https://example.test/reply' } })
      if (p.startsWith('/commits?')) return ok([{ sha }])
      if (p.startsWith(`/commits/${sha}`)) return ok({ sha, html_url: `https://example.test/${sha}`, author: { login: 'evals-bot' }, commit: { message: 'message', author: { name: 'Evals Bot', email: 'evals@example.test', date: new Date().toISOString() } }, files: [{ filename: 'messages/m.txt', status: 'added', additions: 1, deletions: 0 }] })
      if (p.includes('/contents/messages/m.txt')) return ok({ content: b64, encoding: 'base64' })
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    config.github.principals = { 'evals-bot': PEOPLE.owner }
    const sync = new GitHubSync(fake)
    ;(worker as unknown as { github: unknown }).github = sync
    const r = await sync.pull()
    const d = await wait(() => db.collection(C.githubCommits).findOne({ restaurantId: EVAL_TENANT, sha, status: { $in: ['done', 'failed'] }, replyCommit: { $exists: true } }))
    const inbox = d ? await db.collection(C.inbox).findOne({ messageId: `github:${sha}` }) : null
    step(`commit messages/m.txt "${text}"`, inbox as never, [
      ...(r.pulled[0]?.status === 'queued' ? [] : [`pull status ${r.pulled[0]?.status} ${r.pulled[0]?.reason ?? ''}`]),
      ...(d ? [] : ['commit doc never got a reply + replyCommit']),
      ...(verifiedAvail(inbox as never) ? [] : ['onion rings not verified']), ...evalsOk(inbox as never),
    ])
  }
  if (s.custom === 'harness') {
    await db.collection('users').updateOne({ _id: 'user_evals' as never }, { $set: { tenantId: 'tenant_evals', name: 'Evals Owner', handles: [PEOPLE.owner], status: 'active' } }, { upsert: true })
    await db.collection('memberships').updateOne({ _id: 'user_evals:rest' as never }, { $set: { tenantId: 'tenant_evals', userId: 'user_evals', restaurantId: 'rest', role: 'owner' } }, { upsert: true })
    const guid = `evals-guid-${run}-${Date.now()}`
    const ev = (type: string, data: object) => db.collection('evals_audit_events').insertOne({ type, tenantId: 'tenant_evals', actorUserId: 'user_evals', data, at: new Date() })
    // Harness understood this one → Donna must stay out.
    await ev('message.received', { text: 'mark chicken nuggets out of stock', messageId: `${guid}-a` })
    // Harness couldn't parse this one → Donna handles it.
    const text = "we're out of the baklava, and what else is 86'd?"
    await ev('message.received', { text, messageId: guid })
    await ev('intent.unknown', { text })
    const d = await inboxDone(guid)
    const leaked = await db.collection(C.inbox).findOne({ messageId: `${guid}-a` })
    step(text, d as never, [...(leaked ? ['Donna took a message the harness already handled'] : []), ...(d ? [] : ['bridge did not forward']), ...evalsOk(d as never)])
  }
  log.ms = Date.now() - t0
  return log
}

console.log(`OwnerOrbit evals · tenant ${EVAL_TENANT} · sandbox ${orbit.session.apiMode}${live ? ' (LIVE website)' : ''} · agent ${agentAvailable() ? config.agentModel : 'OFF (no key: agent tiers skipped)'} · ${selected.length} scenarios\n`)
for (const s of selected) {
  if (s.custom && !worker) {
    worker = new InboxWorker(orbit, { pollMs: 500, followupMs: 3_600_000 })
    ;(worker as unknown as { github: unknown }).github = new GitHubSync((async () => new Response('[]', { status: 200 })) as typeof fetch)
    await worker.start()
  }
  const n = repeatAll || s.repeat || 1
  for (let run = 1; run <= n; run++) {
    let r: RunLog
    try { r = s.custom ? await runChannel(s, run) : await runSteps(s, run) }
    catch (e) { r = { id: s.id, tier: s.tier, title: s.title, run, pass: false, ms: 0, steps: [], error: (e as Error).message.split('\n')[0] } }
    runs.push(r)
    const bad = r.steps.find((x) => x.failures.length)
    console.log(`${r.pass ? '✅' : '❌'} ${s.id.padEnd(22)} ${n > 1 ? `#${run} ` : ''}${s.title}  ${(r.ms / 1000).toFixed(1)}s`)
    if (!r.pass) {
      if (r.error) console.log(`     error: ${r.error}`)
      if (bad) console.log(`     on "${bad.text}" [${bad.planner}] → ${bad.failures.join('; ')}\n     reply: ${bad.reply.replace(/\n/g, ' ⏎ ').slice(0, 300)}\n     skills: ${bad.skills.join(', ') || '(none)'}`)
    }
  }
}
await worker?.stop()
await orbit.session.close()

// Report: scenarios + per-eval pass rates across every turn.
const evalStats = new Map<string, { pass: number; total: number }>()
for (const st of runs.flatMap((r) => r.steps)) for (const e of st.evals) { const x = evalStats.get(e.name) ?? { pass: 0, total: 0 }; x.total++; if (e.pass) x.pass++; evalStats.set(e.name, x) }
const passed = runs.filter((r) => r.pass).length
const byTier = [...new Set(runs.map((r) => r.tier))].map((t) => { const rs = runs.filter((r) => r.tier === t); return `${t} ${rs.filter((r) => r.pass).length}/${rs.length}` })
console.log(`\n${passed}/${runs.length} scenario runs passed · ${byTier.join(' · ')}`)
console.log('Turn evals: ' + [...evalStats].map(([k, v]) => `${k} ${v.pass}/${v.total}`).join(' · '))
const report = { at: new Date(), tenant: EVAL_TENANT, model: config.agentModel, live, passed, total: runs.length, byTier, evals: Object.fromEntries(evalStats), runs }
mkdirSync('.data/evals', { recursive: true })
const file = `.data/evals/${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify(report, null, 1))
await db.collection('eval_runs').insertOne({ ...report, runs: runs.map((r) => ({ id: r.id, run: r.run, pass: r.pass, ms: r.ms })) })
console.log(`report → ${file} (+ MongoDB eval_runs)`)
if (!args.includes('--keep')) await wipe()
process.exit(passed === runs.length ? 0 : 1)
