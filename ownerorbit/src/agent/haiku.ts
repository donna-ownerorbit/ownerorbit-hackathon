import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.ts'
import type { Preflight, Principal, StepResult } from '../core/executor.ts'
import type { PlanStep, Snapshot } from '../core/types.ts'
import { catalog } from '../nlu/llm.ts'
import { fromToolName, getSkill, jsonSchema, SKILLS, toolName } from '../skills/index.ts'
import type { Turn } from '../telemetry/tracing.ts'
import { brain, type AgentRun, type Playbook, type ToolCallTrace } from './brain.ts'

/**
 * Claude Haiku as OwnerOrbit's agent: a tool loop over the same skill registry the grammar uses.
 *
 * The model chooses WHAT to do. Code decides everything that matters for safety:
 *   - who the sender is and their role (resolved before the agent runs)
 *   - whether a skill is permitted, and whether it needs the owner's YES (Executor.preflight + POLICY)
 *   - whether it worked (each skill re-reads the live dashboard and returns verification checks)
 * Anything that needs approval is parked as a pending confirmation; the next "YES" text runs it
 * deterministically without asking the model again.
 */

export interface AgentDeps {
  llm: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> }
  brain: Pick<typeof brain, 'playbooks' | 'proposePlaybook' | 'memories' | 'remember' | 'objectives' | 'createObjective' | 'updateObjective' | 'scheduleFollowup' | 'upcomingFollowups' | 'handoff' | 'recordRun' | 'createTask' | 'updateTask' | 'openTasks' | 'githubUpdates'>
  preflight(steps: PlanStep[], who: Principal): Promise<Preflight>
  runPlan(steps: PlanStep[], who: Principal, ctx: { messageId: string; text: string; turn: Turn }): Promise<StepResult[]>
}

export interface AgentInput {
  text: string; who: Principal; messageId: string; chat?: string; turn: Turn; snap: Snapshot
  history: { text: string; summaries: string[]; at: number; agent?: { reply: string } }[]
}

export interface AgentOutput {
  reply: string
  /** Skill steps that ran (for undo/history). */
  results: StepResult[]
  steps: PlanStep[]
  /** Steps waiting on the owner's YES. */
  pending: { steps: PlanStep[]; reasons: string[] } | null
  run: AgentRun
}

/** Skills that always need an explicit owner YES when the agent (not the grammar) initiates them. */
export const APPROVAL_REQUIRED = new Set(['menu.item.set_price', 'menu.items.adjust_prices', 'menu.item.set_size', 'menu.item.delete', 'menu.category.delete', 'menu.publish', 'website.publish_page'])

const MAX_ITERATIONS = 10

const STOREFRONTS = `DoorDash: https://www.doordash.com/store/falafel-flare-hayward-2829045/76527170/
Grubhub: https://www.grubhub.com/restaurant/falafel-flare-22648-mission-blvd-hayward/3123318
Uber Eats: https://www.ubereats.com/store/falafel-flare-hayward/HveVg-aOVtyI0Nk6QtHedQ
Dashboard (system of record for menu/orders): ${config.sandboxUrl}`

const SYSTEM = `You are Donna, OwnerOrbit's operations agent for Falafel Flare (locations: Hayward, Fremont, San Leandro). Owners and managers text you over iMessage; each text reaches you through the OwnerOrbit inbox in MongoDB. You change the restaurant's live dashboard only through tools — every skill tool drives the real dashboard, then re-reads it and returns verification checks.

How you work
1. Work out what the sender wants. For operational requests call the matching skill tool(s). When a playbook below covers the request, call get_playbook first and follow it.
2. Never say something happened unless a tool result shows outcome "done" or "noop" with verification ok. The same goes for people: a task or handoff you created is only recorded and assigned. Never say someone is doing it or has done it. If verification failed or a step failed, say exactly what failed. Do not retry a write that failed verification more than once.
3. Approvals and permissions are enforced by code, not by you. A result of "awaiting_owner_approval" means the change is parked: do not call it again; tell the owner in one line what will change and that they reply YES to apply it. "denied" is final — say who can do it.
4. Goals ("get catering to $15k/month", "more lunch orders"): create_objective with a measurable metric, baseline (from sales_report or what the owner said; null if unknown), target, deadline and constraints, plus 2–4 concrete interventions. Then propose exactly ONE next intervention and ask the owner to approve it. When a later message or follow-up brings evidence, update_objective (progress, action status, result).
5. Customer-facing website pages (corporate catering, specials, FAQ) → website__publish_page. Build them from the live catalog: real item names and real prices only, concrete packages (e.g. per-person platters built from actual entrees), how ordering works, lead time. Never invent phone numbers, emails or discounts; if a contact or policy isn't in Business memory, leave it out and ask the owner in your reply. Publishing always needs the owner's YES (code parks it); after it runs, reply with the live URL from the tool result.
6. Work no tool can do — DoorDash / Uber Eats / Grubhub merchant portals, Google Business Profile, vendors, staff — call handoff_instructions with precise numbered steps (where to click, exact values to enter, what the screen should show after) and how to verify. Put the short version in your reply.
7. Anything that should be checked or done later: schedule_followup with a self-contained task (it runs later without this conversation).
8. Learn: owner preferences and durable facts (suppliers, recurring shortages, how they like updates) → remember. If a playbook was wrong, missing a step, or named a tool that doesn't exist, call propose_playbook_update with the corrected full instructions and the reason; the owner approves it on the dashboard's Skills page. At most one proposal per message.
9. A message starting with "[GitHub update …]" is a brief committed to GitHub by a known principal and pulled into MongoDB. Read all of it; compare it with the current dashboard state, objectives and playbooks (get_playbook "github-briefs"); carry out the concrete changes it asks for with skill tools (approval rules still apply); record goals, tasks and handoffs for the rest; and finish with "Suggested next actions:" as a numbered list (max 5). Your reply is stored on the commit in MongoDB and texted to the author.
10. Reply like a text message from a sharp manager: plain text, no markdown headings or bold, lead with the outcome, ≤ 6 short lines unless you are listing changes or instructions.

Playbook tool names → your tools
get_item / get_menu / list unavailable → menu__lookup
set_item_availability → menu__item__set_availability
propose_price_change → menu__item__set_price (one per item; code parks it for the owner's YES) or menu__items__adjust_prices for a category
search_orders → orders__list_active ; moving an order → orders__update_status
sales_summary → insights__sales_report ; morning summary → insights__daily_brief
create/publish a page (catering page etc.) → website__publish_page
list_objectives / objective_progress → the Objectives section below ; create_objective / update_objective / schedule_followup / remember → same-named tools
report_issue / assign_task / request_inventory_count / verify_closing / escalate_problem / request_approval → create_task (kind issue / task / inventory_count / closing_check / escalation / approval_request)
daily_report → insights__daily_brief ; detect_anomaly → insights__sales_report then compare ; publish_menu → menu__publish ; update_modifier → menu__modifier_group__upsert ; add_menu_item → menu__item__create
Catering, marketing, Google Business, DoorDash/Uber/Grubhub portals, website pages → handoff_instructions (until a verified skill exists)

Restaurant slang: "86" / "out of" / "unavailable" = sold_out_today; "for good"/"indefinitely" = sold_out; "hide"/"take off the menu" = hidden; "back"/"un-86" = available. Prefer reversible actions (hide over delete).

Third-party storefronts (for handoffs and spot checks)
${STOREFRONTS}`

type ToolResult = { ok: boolean; content: string }

const BRAIN_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_task',
    description: 'Record operations work for a person in MongoDB: report_issue (kind issue), assign_task (task), request_inventory_count (inventory_count), verify_closing (closing_check), escalate_problem (escalation), request_approval for spending/contracts/staff (approval_request). Returns the saved task re-read from MongoDB.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['issue', 'task', 'inventory_count', 'closing_check', 'escalation', 'approval_request'] },
        title: { type: 'string' }, details: { type: 'string' }, assignee: { type: ['string', 'null'], description: 'name or role; null = owner' },
        due: { type: ['string', 'null'], description: 'ISO 8601 with offset' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, objectiveId: { type: 'string' },
      },
      required: ['kind', 'title', 'details'],
    },
  },
  {
    name: 'update_task',
    description: 'Close, cancel, reassign or record the result of an open task (ids are in the Open tasks section).',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'cancelled'] }, result: { type: 'string' }, assignee: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_playbook',
    description: 'Load the full instructions of a playbook (owner-approved procedure stored in MongoDB). Call before acting on a request a playbook covers.',
    input_schema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] },
  },
  {
    name: 'propose_playbook_update',
    description: 'Propose a new version of a playbook. Goes to the owner for approval on the dashboard Skills page; it does not change the live playbook. Give the complete corrected instructions, not a diff.',
    input_schema: {
      type: 'object',
      properties: { skillId: { type: 'string' }, instructions: { type: 'string' }, description: { type: 'string' }, reason: { type: 'string', description: 'What went wrong or what was missing, with evidence from this conversation.' } },
      required: ['skillId', 'instructions', 'reason'],
    },
  },
  {
    name: 'remember',
    description: 'Store a durable business fact or owner preference for future conversations.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', description: 'e.g. preferences, suppliers, catering, staffing' }, fact: { type: 'string' } }, required: ['topic', 'fact'] },
  },
  {
    name: 'create_objective',
    description: 'Create a long-horizon business objective with a measurable target and concrete interventions.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, metric: { type: 'string', description: 'e.g. catering revenue per month' }, unit: { type: 'string', description: 'e.g. $/month, orders/day, %' },
        baseline: { type: ['number', 'null'] }, target: { type: 'number' }, deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        constraints: { type: 'array', items: { type: 'string' } }, actions: { type: 'array', items: { type: 'string' }, description: '2–4 concrete interventions, most valuable first' },
      },
      required: ['title', 'metric', 'unit', 'target', 'actions'],
    },
  },
  {
    name: 'update_objective',
    description: 'Record progress on an objective, change its status, add interventions, or update one intervention (by actionId).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, current: { type: 'number' }, status: { type: 'string', enum: ['active', 'achieved', 'paused', 'dropped'] }, note: { type: 'string' },
        addActions: { type: 'array', items: { type: 'string' } }, actionId: { type: 'string' },
        actionStatus: { type: 'string', enum: ['todo', 'awaiting_approval', 'done', 'dropped'] }, actionResult: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'schedule_followup',
    description: 'Schedule a task for later (e.g. restore an 86ed item tomorrow 10:30am, check catering progress next week). The task text must be self-contained.',
    input_schema: {
      type: 'object',
      properties: { task: { type: 'string' }, at: { type: 'string', description: 'ISO 8601 with timezone offset' }, inMinutes: { type: 'number' }, objectiveId: { type: 'string' } },
      required: ['task'],
    },
  },
  {
    name: 'handoff_instructions',
    description: 'Record step-by-step instructions for a human to perform in a system no skill can operate (DoorDash/Uber Eats/Grubhub merchant portals, Google Business Profile, website CMS, vendors).',
    input_schema: {
      type: 'object',
      properties: {
        system: { type: 'string' }, title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } },
        verify: { type: 'string', description: 'How to confirm it worked (what to look for, which URL).' }, objectiveId: { type: 'string' },
      },
      required: ['system', 'title', 'steps', 'verify'],
    },
  },
]

function skillTools(): Anthropic.Tool[] {
  return SKILLS.map((s) => ({
    name: toolName(s.id),
    description: `${s.title} [${s.risk}, needs ${s.minRole}${APPROVAL_REQUIRED.has(s.id) ? ', owner YES required' : ''}]. ${s.description}\nExamples: ${s.examples.slice(0, 3).map((e) => `"${e}"`).join(', ')}`,
    input_schema: jsonSchema(s) as Anthropic.Tool.InputSchema,
  }))
}

let cachedTools: Anthropic.Tool[] | null = null
const tools = () => (cachedTools ??= [...skillTools(), ...BRAIN_TOOLS])

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '…' : s)
const textOf = (m: Anthropic.Message) => m.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch { return fallback }
}

export class HaikuAgent {
  constructor(private deps: AgentDeps) {}

  /** Dynamic context: live dashboard state + the business brain. Rebuilt every message. */
  private async context(input: AgentInput, playbooks: Playbook[]) {
    const [objectives, memories, followups, tasks, gh] = await Promise.all([
      safe(() => this.deps.brain.objectives(), []),
      safe(() => this.deps.brain.memories(), []),
      safe(() => this.deps.brain.upcomingFollowups(), []),
      safe(() => this.deps.brain.openTasks(), []),
      safe(() => this.deps.brain.githubUpdates(), []),
    ])
    const now = new Date()
    const objs = objectives.map((o) => `- [${o.id}] ${o.title}: ${o.metric} ${o.current ?? '?'} → ${o.target} ${o.unit}${o.deadline ? ` by ${o.deadline}` : ''}${o.constraints.length ? ` · constraints: ${o.constraints.join('; ')}` : ''}\n` +
      o.actions.map((a) => `    · (${a.id}) [${a.status}] ${a.text}${a.result ? ` → ${a.result}` : ''}`).join('\n'))
    const hist = input.history.slice(-6).map((h) => `- ${new Date(h.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} sender: "${h.text}"` +
      (h.summaries.length ? `\n  actions: ${h.summaries.map((s) => s.split('\n')[0]).join('; ')}` : '') + (h.agent ? `\n  you replied: "${h.agent.reply}"` : ''))
    return [
      `# Now\n${now.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })} (ISO ${now.toISOString()})`,
      `# Sender\n${input.who.id} · role ${input.who.role}`,
      `# Playbooks (call get_playbook for full instructions)\n${playbooks.map((p) => `- ${p.skillId} v${p.version}: ${p.name} — ${p.description}`).join('\n') || '(none in MongoDB)'}`,
      `# Objectives\n${objs.join('\n') || '(none yet)'}`,
      `# Business memory\n${memories.map((m) => `- [${m.topic}] ${m.fact}`).join('\n') || '(empty)'}`,
      `# Open tasks\n${tasks.map((t) => `- [${t.id}] ${t.kind} · ${t.title}${t.assignee ? ` → ${t.assignee}` : ''}${t.dueAt ? ` due ${new Date(t.dueAt).toISOString()}` : ''} (${t.priority})`).join('\n') || '(none)'}`,
      `# Briefs pulled from GitHub (latest first)\n${gh.map((g) => `- ${String(g.sha).slice(0, 7)} ${new Date(g.committedAt).toISOString().slice(0, 16)} ${g.author?.name ?? ''}: ${String(g.message).split('\n')[0]} [${g.status}]`).join('\n') || '(none)'}`,
      `# Scheduled follow-ups\n${followups.map((f) => `- ${new Date(f.dueAt).toISOString()} ${f.task}`).join('\n') || '(none)'}`,
      `# Recent conversation with this sender (oldest first; a short reply like "yes" usually answers your last question)\n${hist.join('\n') || '(none)'}`,
      catalog(input.snap),
    ].join('\n\n')
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const t0 = Date.now()
    const { who, turn } = input
    const playbooks = await safe(() => this.deps.brain.playbooks(), [] as Playbook[])
    const used = new Map<string, number>()
    const calls: ToolCallTrace[] = []
    const results: StepResult[] = []
    const steps: PlanStep[] = []
    const pending: { steps: PlanStep[]; reasons: string[] } = { steps: [], reasons: [] }
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: await this.context(input, playbooks) },
    ]
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: input.text }]

    const call = async (name: string, raw: unknown): Promise<ToolResult> => {
      const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const skill = getSkill(fromToolName(name))
      if (skill) {
        const step: PlanStep = { skill: skill.id, input: args }
        const pre = await this.deps.preflight([step], who)
        if (pre.blocked.length) {
          const b = pre.blocked[0]
          return { ok: false, content: JSON.stringify({ outcome: b.outcome, summary: b.summary, hint: b.hint }) }
        }
        const reasons = [...pre.confirmations, ...(APPROVAL_REQUIRED.has(skill.id) && !pre.confirmations.length ? [`${skill.title}: ${JSON.stringify(args)}`] : [])]
        if (reasons.length) {
          pending.steps.push(step)
          pending.reasons.push(...reasons)
          return { ok: true, content: JSON.stringify({ outcome: 'awaiting_owner_approval', reasons, note: 'Parked. It runs only if the owner replies YES. Do not call it again.' }) }
        }
        const [r] = await this.deps.runPlan([step], who, { messageId: input.messageId, text: input.text, turn })
        results.push(r)
        steps.push(step)
        const v = r.verification
        return {
          ok: r.outcome !== 'failed' && r.outcome !== 'denied',
          content: JSON.stringify({
            outcome: r.outcome, summary: r.summary, hint: r.hint, error: r.error, actionId: r.actionId, ms: r.ms,
            verification: v ? { ok: v.ok, level: v.level, checks: v.checks.slice(0, 12) } : skill.risk === 'read' ? 'read-only' : 'none',
          }),
        }
      }

      const by = `agent:${who.id}`
      switch (name) {
        case 'get_playbook': {
          const p = playbooks.find((x) => x.skillId === args.skillId)
          if (!p) return { ok: false, content: `No playbook "${String(args.skillId)}". Available: ${playbooks.map((x) => x.skillId).join(', ') || 'none'}` }
          used.set(p.skillId, p.version)
          return { ok: true, content: `${p.name} (v${p.version})\n${p.instructions}` }
        }
        case 'propose_playbook_update': {
          const r = await this.deps.brain.proposePlaybook({ skillId: String(args.skillId), instructions: String(args.instructions), description: args.description as string | undefined, reason: String(args.reason) })
          return { ok: true, content: JSON.stringify({ ...r, status: 'pending owner approval on the dashboard Skills page' }) }
        }
        case 'remember':
          await this.deps.brain.remember(String(args.topic), String(args.fact), by)
          return { ok: true, content: 'Saved.' }
        case 'create_objective': {
          const o = await this.deps.brain.createObjective({
            title: String(args.title), metric: String(args.metric), unit: String(args.unit),
            baseline: typeof args.baseline === 'number' ? args.baseline : null, target: Number(args.target),
            deadline: typeof args.deadline === 'string' ? args.deadline : null,
            constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [], actions: Array.isArray(args.actions) ? args.actions.map(String) : [],
          }, by)
          return { ok: true, content: JSON.stringify({ id: o.id, actions: o.actions.map((a) => ({ id: a.id, text: a.text })) }) }
        }
        case 'update_objective': {
          const { id, ...u } = args as { id: string } & Parameters<AgentDeps['brain']['updateObjective']>[1]
          await this.deps.brain.updateObjective(String(id), u, by)
          return { ok: true, content: 'Updated.' }
        }
        case 'schedule_followup': {
          const dueAt = typeof args.at === 'string' ? new Date(args.at) : new Date(Date.now() + Number(args.inMinutes ?? 60) * 60_000)
          if (Number.isNaN(dueAt.getTime())) return { ok: false, content: 'Invalid "at" — use ISO 8601 with offset, or inMinutes.' }
          if (dueAt.getTime() < Date.now() - 60_000) return { ok: false, content: `That time is in the past (now ${new Date().toISOString()}).` }
          const f = await this.deps.brain.scheduleFollowup({ task: String(args.task), dueAt, principal: who.id, role: who.role, chat: input.chat, objectiveId: args.objectiveId as string | undefined })
          return { ok: true, content: JSON.stringify({ id: f.id, dueAt: f.dueAt.toISOString() }) }
        }
        case 'create_task': {
          const due = typeof args.due === 'string' ? new Date(args.due) : null
          if (due && Number.isNaN(due.getTime())) return { ok: false, content: 'Invalid "due" — use ISO 8601 with offset.' }
          const t = await this.deps.brain.createTask({
            kind: String(args.kind) as never, title: String(args.title), details: String(args.details ?? ''), assignee: typeof args.assignee === 'string' ? args.assignee : null,
            dueAt: due, priority: (['low', 'normal', 'high', 'urgent'].includes(String(args.priority)) ? args.priority : 'normal') as never, objectiveId: args.objectiveId as string | undefined,
          }, by)
          return { ok: true, content: JSON.stringify({ saved: t, verification: 're-read from MongoDB' }) }
        }
        case 'update_task': {
          const t = await this.deps.brain.updateTask(String(args.id), { status: args.status as never, result: args.result as string | undefined, assignee: args.assignee as string | undefined }, by)
          return { ok: true, content: JSON.stringify(t) }
        }
        case 'handoff_instructions': {
          const h = await this.deps.brain.handoff({ system: String(args.system), title: String(args.title), steps: Array.isArray(args.steps) ? args.steps.map(String) : [], verify: String(args.verify), objectiveId: args.objectiveId as string | undefined }, by)
          return { ok: true, content: JSON.stringify({ handoffId: h.id, note: 'Saved for the team. Summarise the steps in your reply.' }) }
        }
      }
      return { ok: false, content: `Unknown tool ${name}.` }
    }

    let reply = ''
    let stopReason: string | null = null
    let llmCalls = 0
    for (;;) {
      if (llmCalls >= MAX_ITERATIONS) {
        stopReason = 'max_iterations'
        reply = 'I hit my step limit on that one — here is where things stand.'
        turn.signal('agent_max_iterations', 'NEGATIVE', {})
        break
      }
      llmCalls++
      let res: Anthropic.Message
      try {
        res = await this.deps.llm.create({
          model: config.agentModel,
          max_tokens: 16000,
          output_config: { effort: 'medium' },
          system,
          tools: tools(),
          tool_choice: { type: 'auto' },
          messages,
        })
      } catch (e) {
        reply = e instanceof Anthropic.RateLimitError ? "I'm rate-limited for a moment — text me again in a minute."
          : e instanceof Anthropic.APIConnectionError ? "I can't reach my planner right now; nothing was changed."
            : e instanceof Anthropic.APIError ? `My planner returned an error (${e.status}); nothing further was changed.`
              : `Something broke while planning (${(e as Error).message.slice(0, 100)}).`
        turn.signal('agent_llm_error', 'NEGATIVE', { error: (e as Error).message })
        stopReason = 'error'
        break
      }
      usage.input += res.usage.input_tokens
      usage.output += res.usage.output_tokens
      usage.cacheRead += res.usage.cache_read_input_tokens ?? 0
      usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0
      stopReason = res.stop_reason
      // Append the whole content (thinking blocks included) so the loop stays valid for the API.
      messages.push({ role: 'assistant', content: res.content })

      if (res.stop_reason === 'refusal') { reply = "I can't help with that one."; break }
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      if (res.stop_reason !== 'tool_use' || !uses.length) { reply = textOf(res); break }

      // The browser is a single page, so tool calls run in order; all results go back in one message.
      const out: Anthropic.ToolResultBlockParam[] = []
      for (const u of uses) {
        const t = Date.now()
        let r: ToolResult
        try {
          r = await turn.tool(`agent.${u.name}`, u.input as Record<string, unknown>, () => call(u.name, u.input))
        } catch (e) {
          r = { ok: false, content: `Error: ${(e as Error).message.split('\n')[0]}` }
        }
        calls.push({ name: u.name, input: u.input, ok: r.ok, result: clip(r.content, 600), ms: Date.now() - t })
        out.push({ type: 'tool_result', tool_use_id: u.id, content: clip(r.content), is_error: !r.ok })
      }
      messages.push({ role: 'user', content: out })
    }

    // Code-owned truth: the reply can't hide a failed verification or a parked approval.
    const failed = results.filter((r) => r.outcome === 'failed')
    if (failed.length && !/fail|couldn|didn|not /i.test(reply)) reply += '\n' + failed.map((r) => `⚠️ ${r.summary} — verification failed.`).join('\n')
    if (pending.steps.length && !/\bYES\b/.test(reply)) reply += `\nWaiting on you: ${pending.reasons.join(' ')}\nReply YES to apply or NO to cancel.`
    if (!reply.trim()) reply = results.length ? results.map((r) => r.summary).join('\n') : "Sorry, I didn't get that."

    const run: AgentRun = {
      runId: randomUUID(), messageId: input.messageId, principal: who.id, role: who.role, text: input.text, model: config.agentModel,
      playbooks: [...used].map(([skillId, version]) => ({ skillId, version })), calls, iterations: llmCalls,
      stopReason, reply, awaitingApproval: pending.steps.length > 0, usage, ms: Date.now() - t0, at: new Date(),
    }
    turn.props({ agent_model: config.agentModel, agent_calls: calls.length, agent_iterations: run.iterations, agent_playbooks: run.playbooks.map((p) => `${p.skillId}@v${p.version}`).join(',') })
    await this.deps.brain.recordRun(run).catch((e) => console.warn('[agent] run not recorded:', (e as Error).message))
    return { reply: reply.trim(), results, steps, pending: pending.steps.length ? pending : null, run }
  }
}

let client: Anthropic | null = null
export const agentAvailable = () => !!config.anthropicKey
export const anthropic = () => (client ??= new Anthropic({ apiKey: config.anthropicKey }))
