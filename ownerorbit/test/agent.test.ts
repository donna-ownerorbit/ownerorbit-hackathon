import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type Anthropic from '@anthropic-ai/sdk'
import { HaikuAgent, type AgentDeps } from '../src/agent/haiku.ts'
import type { Preflight, Principal, StepResult } from '../src/core/executor.ts'
import type { PlanStep, Snapshot } from '../src/core/types.ts'
import type { Turn } from '../src/telemetry/tracing.ts'

const snap: Snapshot = JSON.parse(readFileSync(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8'))
const owner: Principal = { id: '5105550100', role: 'owner' }
const turn: Turn = { eventId: 't', tool: (_n, _i, fn) => fn(), props() {}, signal() {}, evals() {}, diagnose() {}, async finish() {} }

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
const msg = (blocks: Block[]): Anthropic.Message => ({
  id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_sequence: null, stop_details: null,
  stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
  content: blocks.map((b, i) => (b.type === 'tool_use' ? { type: 'tool_use', id: `tu_${i}`, name: b.name, input: b.input } : { type: 'text', text: b.text, citations: null })),
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
} as unknown as Anthropic.Message)

function harness(script: Anthropic.Message[], opts: { preflight?: (s: PlanStep[]) => Preflight; run?: (s: PlanStep) => Partial<StepResult> } = {}) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []
  const ran: PlanStep[] = []
  const store = { runs: [] as unknown[], objectives: [] as unknown[], memory: [] as unknown[], followups: [] as unknown[], handoffs: [] as unknown[], proposals: [] as unknown[], tasks: [] as unknown[] }
  const deps: AgentDeps = {
    llm: {
      async create(body) {
        requests.push(structuredClone(body))
        const next = script.shift()
        if (!next) throw new Error('script exhausted')
        return next
      },
    },
    brain: {
      playbooks: async () => [{ skillId: 'availability-ops', version: 3, name: 'Availability (86 list)', description: '86 rules', instructions: 'Use set_item_availability.' }],
      proposePlaybook: async (p) => { store.proposals.push(p); return { proposalId: 'p1', baseVersion: 3, fields: ['instructions'] } as never },
      memories: async () => [],
      remember: async (topic, fact) => { store.memory.push({ topic, fact }) },
      objectives: async () => [],
      createObjective: async (o) => { store.objectives.push(o); return { id: 'catering-1', actions: o.actions.map((t, i) => ({ id: `a${i}`, text: t, status: 'todo' })) } as never },
      updateObjective: async () => ({}) as never,
      scheduleFollowup: async (f) => { store.followups.push(f); return { id: 'f1', dueAt: f.dueAt } },
      upcomingFollowups: async () => [],
      handoff: async (h) => { store.handoffs.push(h); return { id: 'h1' } as never },
      recordRun: async (r) => { store.runs.push(r) },
      createTask: async (t) => { store.tasks.push(t); return { id: 'issue-1', kind: t.kind, status: 'open' } as never },
      updateTask: async (id, u) => ({ id, ...u }) as never,
      openTasks: async () => [],
      githubUpdates: async () => [],
    },
    preflight: async (steps) => opts.preflight?.(steps) ?? { blocked: [], confirmations: [] },
    runPlan: async (steps) => steps.map((step) => {
      ran.push(step)
      return { step, actionId: 'act1', outcome: 'done', summary: 'Chicken Nuggets with Fries → sold out today', ms: 900, verification: { ok: true, level: 'durable', checks: [{ name: 'status', expected: 'sold_out_today', actual: 'sold_out_today', ok: true }] }, ...opts.run?.(step) } as StepResult
    }),
  }
  const agent = new HaikuAgent(deps)
  const go = (text: string) => agent.run({ text, who: owner, messageId: 'm1', chat: 'iMessage;-;+15105550100', turn, snap, history: [] })
  return { go, requests, ran, store }
}

test('loads the playbook, runs the skill, and records which playbook version guided it', async () => {
  const h = harness([
    msg([{ type: 'tool_use', name: 'get_playbook', input: { skillId: 'availability-ops' } }]),
    msg([{ type: 'tool_use', name: 'menu__item__set_availability', input: { items: ['Chicken Nuggets with Fries'], status: 'sold_out_today' } }]),
    msg([{ type: 'text', text: 'Done. Chicken Nuggets are sold out today — verified on the dashboard.' }]),
  ])
  const out = await h.go('we ran out of nuggets, take them off for today')
  assert.equal(h.ran.length, 1)
  assert.equal(h.ran[0].skill, 'menu.item.set_availability')
  assert.equal(out.results[0].outcome, 'done')
  assert.equal(out.pending, null)
  assert.deepEqual(out.run.playbooks, [{ skillId: 'availability-ops', version: 3 }])
  assert.equal(out.run.calls.length, 2)
  assert.equal(h.store.runs.length, 1)
  assert.match(out.reply, /verified/)
  // Tool results go back in a single user message after the assistant turn (content preserved verbatim).
  const third = h.requests[2].messages
  assert.equal(third.at(-1)!.role, 'user')
  assert.equal((third.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0].type, 'tool_result')
  assert.equal(h.requests[0].model, 'claude-haiku-5-5')
})

test('price changes are parked for the owner YES even when preflight would allow them', async () => {
  const h = harness([
    msg([{ type: 'tool_use', name: 'menu__item__set_price', input: { item: 'Flame Burger', price: 17.99 } }]),
    msg([{ type: 'text', text: 'Flame Burger would go to $17.99.' }]),
  ])
  const out = await h.go('flame burger should be 17.99')
  assert.equal(h.ran.length, 0, 'nothing executed')
  assert.equal(out.pending?.steps[0].skill, 'menu.item.set_price')
  assert.match(out.reply, /Reply YES/)
  assert.equal(out.run.awaitingApproval, true)
})

test('permission denials come from code and stop the step', async () => {
  const h = harness([
    msg([{ type: 'tool_use', name: 'menu__items__adjust_prices', input: { category: 'Burgers', percent: 5 } }]),
    msg([{ type: 'text', text: 'Only the owner can reprice the menu.' }]),
  ], { preflight: (steps) => ({ blocked: [{ step: steps[0], actionId: 'x', outcome: 'denied', summary: 'Bulk price adjustment needs owner access.', ms: 0 }], confirmations: [] }) })
  const out = await h.go('raise burgers 5%')
  assert.equal(h.ran.length, 0)
  assert.equal(out.pending, null)
  const result = (h.requests[1].messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]
  assert.equal(result.is_error, true)
  assert.match(String(result.content), /denied/)
})

test('a cheerful reply cannot hide a failed verification', async () => {
  const h = harness([
    msg([{ type: 'tool_use', name: 'menu__item__set_availability', input: { items: ['Dolma'], status: 'hidden' } }]),
    msg([{ type: 'text', text: 'All set!' }]),
  ], { run: () => ({ outcome: 'failed', summary: 'Dolma → hidden', verification: { ok: false, level: 'durable', checks: [{ name: 'status', expected: 'hidden', actual: 'available', ok: false }] } }) })
  const out = await h.go('hide dolma')
  assert.match(out.reply, /verification failed/)
})

test('goals become objectives; outside systems become handoffs and follow-ups', async () => {
  const h = harness([
    msg([
      { type: 'tool_use', name: 'create_objective', input: { title: 'Catering to $15k/month', metric: 'catering revenue', unit: '$/month', baseline: 6000, target: 15000, deadline: '2027-01-31', actions: ['Corporate catering page', 'Outreach to 20 offices'] } },
      { type: 'tool_use', name: 'handoff_instructions', input: { system: 'DoorDash', title: 'Enable DoorDash catering', steps: ['Open merchant portal', 'Menu → Catering → On'], verify: 'Catering tab visible on storefront' } },
      { type: 'tool_use', name: 'schedule_followup', input: { task: 'Check catering revenue vs $15k target', inMinutes: 10080 } },
    ]),
    msg([{ type: 'text', text: 'Objective set: $6k → $15k/month. First intervention: a corporate catering page. Approve?' }]),
  ])
  const out = await h.go('get catering to $15k a month')
  assert.equal((h.store.objectives[0] as { baseline: number }).baseline, 6000)
  assert.equal(h.store.handoffs.length, 1)
  assert.equal((h.store.followups[0] as { chat: string }).chat, 'iMessage;-;+15105550100')
  assert.equal(out.run.calls.length, 3)
  // All three results returned together in one message.
  assert.equal((h.requests[1].messages.at(-1)!.content as unknown[]).length, 3)
})

test('model/API failure degrades to a safe reply', async () => {
  const h = harness([])
  const out = await h.go('what should we do about slow tuesdays')
  assert.match(out.reply, /Something broke|planner/)
  assert.equal(out.run.stopReason, 'error')
})

test('operations skills from the brief become verified MongoDB tasks', async () => {
  const h = harness([
    msg([{ type: 'tool_use', name: 'create_task', input: { kind: 'inventory_count', title: 'Count lamb chops', details: 'Before dinner rush', assignee: 'Ali', due: '2026-10-12T16:00:00-07:00', priority: 'high' } }]),
    msg([{ type: 'text', text: 'Asked Ali to count lamb chops by 4pm.' }]),
  ])
  const out = await h.go('have ali count the lamb chops before 4')
  const t = h.store.tasks[0] as { kind: string; dueAt: Date; priority: string }
  assert.equal(t.kind, 'inventory_count')
  assert.equal(t.priority, 'high')
  assert.equal(t.dueAt.toISOString(), '2026-10-12T23:00:00.000Z')
  assert.match(out.run.calls[0].result, /re-read from MongoDB/)
})
