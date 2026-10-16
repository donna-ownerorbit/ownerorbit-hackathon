import { randomUUID } from 'node:crypto'
import { config, type Role } from '../config.ts'
import { SandboxSession } from '../browser/session.ts'
import { llmAvailable, llmPlan } from '../nlu/llm.ts'
import { Parser, type Focus, type Parse } from '../nlu/parser.ts'
import { getSkill, SKILLS } from '../skills/index.ts'
import { evidence } from '../telemetry/evidence.ts'
import { beginTurn, type Turn } from '../telemetry/tracing.ts'
import { Executor, type Principal, type StepResult } from './executor.ts'
import { Memory } from './memory.ts'
import { evaluateTurn, type EvalResult } from '../telemetry/evals.ts'
import { lookupPrincipal, refreshPrincipals } from './principals.ts'
import { agentAvailable, anthropic, HaikuAgent } from '../agent/haiku.ts'
import { brain } from '../agent/brain.ts'
import type { PlanStep } from './types.ts'

export interface Inbound {
  from: string; text: string; messageId?: string; chat?: string; trusted?: boolean
  /** Scheduler only: run as the principal who scheduled the follow-up (re-checked against RBAC by every skill). */
  actAs?: Principal
  /** Long-form sources (GitHub briefs) skip the grammar and go straight to the agent. */
  source?: 'imessage' | 'github'
}
export interface Outbound { reply: string; results: StepResult[]; planner: string; ms: number; ignored?: boolean; evals?: EvalResult[] }

const normalize = (h: string) => { const d = h.replace(/[^\d]/g, ''); return d.length >= 10 ? d.slice(-10) : h.trim().toLowerCase() }

/** Requests the grammar might half-parse but that need judgment: goals, strategy, multi-system work. */
/** Agent tools whose success means a write landed in MongoDB (count as evidence for a "done" claim). */
const BRAIN_WRITES = new Set(['create_task', 'update_task', 'create_objective', 'update_objective', 'schedule_followup', 'handoff_instructions', 'remember', 'propose_playbook_update'])
const AGENT_FIRST = /\b(objective|goal|target|grow|increase (?:our|my)? ?(?:catering|sales|revenue|orders)|catering|strategy|plan for|why (?:are|is|did)|what should|doordash|uber ?eats|grubhub|google|website|remind|follow ?up|tomorrow|next week|until)\b/i

/**
 * OwnerOrbit core: identity → memory → planning → skill execution → verification → reply.
 * Transport-agnostic: BlueBubbles, the CLI and the HTTP simulator all call handle().
 */
export class OwnerOrbit {
  readonly session: SandboxSession
  readonly exec: Executor
  readonly memory = new Memory()
  readonly agent: HaikuAgent
  private queues = new Map<string, Promise<unknown>>()

  constructor(session?: SandboxSession) {
    this.session = session ?? new SandboxSession()
    this.exec = new Executor(this.session)
    this.agent = new HaikuAgent({
      llm: { create: (body) => anthropic().messages.create(body) },
      brain,
      preflight: (steps, who) => this.exec.preflight(steps, who),
      runPlan: (steps, who, ctx) => this.exec.runPlan(steps, who, ctx),
    })
  }

  identify(from: string, trusted?: boolean): Principal | null {
    const p = lookupPrincipal(from)
    if (p) return { id: p.id, role: p.role }
    return trusted ? { id: from, role: 'owner' as Role } : null
  }

  /** Messages from one person run strictly in order; different people interleave at step granularity. */
  handle(msg: Inbound): Promise<Outbound> {
    const key = normalize(msg.from)
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.process(msg), () => this.process(msg))
    this.queues.set(key, next.catch(() => undefined))
    return next
  }

  private async process(msg: Inbound): Promise<Outbound> {
    const t0 = Date.now()
    const messageId = msg.messageId ?? randomUUID()
    if (!this.memory.firstTime(messageId)) return { reply: '', results: [], planner: 'dedupe', ms: 0, ignored: true }
    await refreshPrincipals()
    const who = msg.actAs ?? this.identify(msg.from, msg.trusted)
    if (!who) return { reply: "Sorry — this number isn't on Falafel Flare's staff list.", results: [], planner: 'auth', ms: Date.now() - t0 }
    await this.memory.load(who.id)

    const turn = beginTurn({ eventId: messageId, userId: who.id, convoId: msg.chat, input: msg.text })
    turn.props({ role: who.role, sandbox: this.session.url })
    let planner = 'rules'
    let plan: unknown = null
    let out: { reply: string; results: StepResult[] }
    try {
      await this.session.start()
      await this.session.say(msg.text, 'Thinking…')
      const r = await this.respond(msg.text, who, messageId, turn, msg.chat, msg.source === 'github')
      planner = r.planner
      plan = r.plan
      out = r
    } catch (e) {
      console.error('[orbit]', e)
      turn.signal('crash', 'NEGATIVE', { error: (e as Error).message })
      out = { reply: `Something broke on my side (${(e as Error).message.split('\n')[0].slice(0, 120)}). Nothing else was changed.`, results: [] }
    }
    const ms = Date.now() - t0
    await this.session.say(msg.text, out.reply.split('\n')[0], out.results.some((r) => r.outcome === 'failed') ? 'fail' : 'ok')
    turn.props({ planner, steps: out.results.length, ms })
    const recorded = ((plan as { recorded?: string[] } | null)?.recorded) ?? []
    const evals = evaluateTurn({ reply: out.reply, planner, results: out.results, ms, awaitingApproval: this.memory.get(who.id).pending?.kind === 'confirm', recorded })
    turn.evals(evals, { planner, skills: out.results.map((r) => r.step.skill).join(',') })
    for (const r of out.results.filter((x) => x.outcome === 'failed')) {
      turn.diagnose(`${r.step.skill} failed: ${r.summary}${r.error ? ` (${r.error.slice(0, 200)})` : ''}`, r.verification && !r.verification.ok ? 'repeatedly_broken_tool' : 'complete_task_failure', { skill: r.step.skill })
    }
    const failedEvals = evals.filter((e) => !e.pass)
    console.log(`  🧪 evals ${evals.length - failedEvals.length}/${evals.length}${failedEvals.length ? ' — FAIL ' + failedEvals.map((e) => `${e.name} (${e.detail})`).join('; ') : ''}`)
    await turn.finish(out.reply)
    await this.memory.flush()
    await evidence.message({ messageId, principal: who.id, chat: msg.chat, text: msg.text, planner, plan, reply: out.reply, ms, at: new Date() }).catch(() => undefined)
    return { ...out, planner, ms, evals }
  }

  private async respond(text: string, who: Principal, messageId: string, turn: Turn, chat?: string, agentOnly = false): Promise<{ reply: string; results: StepResult[]; planner: string; plan: unknown }> {
    const convo = this.memory.get(who.id)
    const snap = await this.exec.snapshot()
    const parser = new Parser(snap, convo.focus)
    let parsed: Parse = parser.parse(text)
    let planner = 'rules'
    const ctx = { messageId, text, turn }

    // 1. Something pending from the last message?
    const p = convo.pending
    if (p) {
      if (p.kind === 'confirm') {
        if (parsed.kind === 'meta' && parsed.meta === 'yes') {
          this.memory.clearPending(who.id)
          const done = await this.execute(p.steps, who, { ...ctx, text: p.text }, true)
          // The YES itself is deterministic. Afterwards the agent closes the loop: record the outcome
          // against the objective and propose the next action (it can't re-run what just ran).
          if (p.agent && agentAvailable() && done.results.some((r) => r.outcome === 'done')) {
            const note = `[Owner approved "${p.text}". Executed and verified:\n${done.results.map((r) => `- ${r.step.skill}: ${r.outcome} — ${r.summary}`).join('\n')}]\nUpdate any related objective (mark the intervention done with this result) and tell the owner the single next step. Do not repeat these actions.`
            const next = await this.agent.run({ text: note, who, messageId: `${messageId}:after`, chat, turn, snap: await this.exec.snapshot(), history: this.memory.get(who.id).history }).catch(() => null)
            if (next?.pending) this.memory.setPending(who.id, { kind: 'confirm', steps: next.pending.steps, reasons: next.pending.reasons, text: note, agent: true })
            if (next?.reply) done.reply += '\n\n' + next.reply
          }
          return { ...done, planner: 'confirm', plan: p.steps }
        }
        if (parsed.kind === 'meta' && parsed.meta === 'no') { this.memory.clearPending(who.id); return { reply: 'Okay, cancelled. Nothing was changed.', results: [], planner: 'confirm', plan: null } }
      }
      if (p.kind === 'choose') {
        const n = parsed.kind === 'meta' && parsed.meta === 'choice' ? parsed.value! - 1 : p.options.findIndex((o) => o.label.toLowerCase() === text.trim().toLowerCase() || o.label.toLowerCase().includes(text.trim().toLowerCase()) && text.trim().length > 2)
        if (n >= 0 && n < p.options.length) {
          this.memory.clearPending(who.id)
          const opt = p.options[n]
          if (opt.steps.length) return { ...(await this.execute(opt.steps, who, { ...ctx, text: p.text }, false)), planner: 'choice', plan: opt.steps }
          return this.respond(`${p.text} — ${opt.label}`, who, messageId, turn, chat)
        }
        if (parsed.kind === 'meta' && parsed.meta === 'no') { this.memory.clearPending(who.id); return { reply: 'Okay, never mind.', results: [], planner: 'choice', plan: null } }
      }
      if (p.kind === 'fill') {
        const v = p.type === 'number' ? text.match(/\d+(?:\.\d{1,2})?/)?.[0] : text.trim()
        if (v && !(parsed.kind === 'meta' && parsed.meta === 'no') && (p.type === 'number' || parsed.kind !== 'plan')) {
          this.memory.clearPending(who.id)
          const step: PlanStep = { ...p.step, input: { ...p.step.input, [p.field]: p.type === 'number' ? parseFloat(v) : v } }
          return { ...(await this.execute([step], who, { ...ctx, text: p.text }, false)), planner: 'fill', plan: [step] }
        }
        if (parsed.kind === 'meta' && parsed.meta === 'no') { this.memory.clearPending(who.id); return { reply: 'Okay, dropped it.', results: [], planner: 'fill', plan: null } }
      }
      this.memory.clearPending(who.id) // a new command supersedes the question
    }

    // 2. Grammar first (cheap, deterministic); the Haiku agent for anything it can't parse or that needs judgment.
    // A bare "yes" / "no" / "2" with nothing parked answers the agent's last question, if it asked one recently.
    const last = convo.history.at(-1)
    const answersAgent = !!last?.agent && Date.now() - last.at < 30 * 60_000 && parsed.kind === 'meta' && ['yes', 'no', 'choice'].includes(parsed.meta)
    if (agentOnly && !agentAvailable()) return { reply: 'GitHub briefs need the Haiku agent (ANTHROPIC_API_KEY); nothing was changed.', results: [], planner: 'haiku', plan: null }
    if (agentAvailable() && (agentOnly || (config.planner === 'agent' && (answersAgent || (parsed.kind !== 'meta' &&
      (parsed.kind === 'unknown' || (parsed.kind === 'plan' && parsed.confidence < 0.6) || AGENT_FIRST.test(text))))))) {
      const r = await this.agent.run({ text, who, messageId, chat, turn, snap, history: convo.history })
      this.remember(who, ctx, r.steps, r.results, { reply: r.reply })
      if (r.pending) this.memory.setPending(who.id, { kind: 'confirm', steps: r.pending.steps, reasons: r.pending.reasons, text, agent: true })
      return { reply: r.reply, results: r.results, planner: 'haiku', plan: { runId: r.run.runId, calls: r.run.calls.map((c) => c.name), pending: r.pending?.steps ?? [], recorded: r.run.calls.filter((c) => c.ok && BRAIN_WRITES.has(c.name)).map((c) => c.name) } }
    }
    if ((parsed.kind === 'unknown' || (parsed.kind === 'plan' && parsed.confidence < 0.6)) && config.planner !== 'rules' && llmAvailable()) {
      const llm = await turn.tool('planner.claude', { text }, () => llmPlan(text, snap, convo.focus))
      if (llm.kind !== 'unknown' || parsed.kind === 'unknown') { parsed = llm; planner = 'claude' }
    }
    if (config.planner === 'llm' && llmAvailable() && parsed.kind !== 'meta') { parsed = await llmPlan(text, snap, convo.focus); planner = 'claude' }

    switch (parsed.kind) {
      case 'meta': return { ...(await this.meta(parsed, who, ctx)), planner, plan: null }
      case 'clarify': {
        this.memory.setPending(who.id, { kind: 'choose', question: parsed.question, options: parsed.options, text })
        return { reply: `${parsed.question}\n${parsed.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n')}`, results: [], planner, plan: parsed }
      }
      case 'ask': {
        this.memory.setPending(who.id, { kind: 'fill', step: parsed.step, field: parsed.field, type: parsed.type, question: parsed.question, text })
        return { reply: parsed.question, results: [], planner, plan: parsed }
      }
      case 'unknown': {
        const why = parsed.reason && !/^(empty|no action|no LLM configured)$/.test(parsed.reason) ? ` (${parsed.reason})` : ''
        return { reply: `I didn't catch that${why}. Try "86 the nuggets", "pause orders 30 min", or text "help".`, results: [], planner, plan: null }
      }
      case 'plan': {
        const r = await this.execute(parsed.steps, who, ctx, false)
        if (parsed.notes?.length && r.results.some((x) => x.outcome === 'done')) r.reply += '\n' + parsed.notes.join('\n')
        return { ...r, planner, plan: parsed.steps }
      }
    }
  }

  /** Preflight (permissions, validation, confirmations), then run + verify. */
  async execute(steps: PlanStep[], who: Principal, ctx: { messageId: string; text: string; turn: Turn; undoOf?: string }, confirmed: boolean) {
    const pre = await this.exec.preflight(steps, who)
    if (pre.blocked.length) return { reply: pre.blocked.map((b) => b.summary + (b.hint ? ` ${b.hint}` : '')).join('\n'), results: pre.blocked }
    if (pre.confirmations.length && !confirmed) {
      this.memory.setPending(who.id, { kind: 'confirm', steps, reasons: pre.confirmations, text: ctx.text })
      return { reply: `Heads up: ${pre.confirmations.join(' ')}\nReply YES to go ahead or NO to cancel.`, results: [] }
    }
    const results = await this.exec.runPlan(steps, who, ctx)
    this.remember(who, ctx, steps, results)
    return { reply: format(results), results }
  }

  private remember(who: Principal, ctx: { messageId: string; text: string; undoOf?: string }, steps: PlanStep[], results: StepResult[], agent?: { reply: string }) {
    const focus: Focus = { lastStep: steps.at(-1) }
    for (const s of steps) {
      const i = s.input as Record<string, unknown>
      if (Array.isArray(i.items)) focus.items = i.items as string[]
      if (typeof i.item === 'string') focus.items = [i.item]
      if (typeof i.category === 'string') focus.category = i.category
      if (Array.isArray(i.orders)) focus.order = (i.orders as string[])[0]
    }
    const inverse = results.filter((r) => r.outcome === 'done' && r.inverse?.length).reverse().flatMap((r) => r.inverse!)
    if (ctx.undoOf) {
      const h = this.memory.get(who.id).history.find((x) => x.messageId === ctx.undoOf)
      if (h) h.undone = true
    }
    this.memory.remember(who.id, { messageId: ctx.messageId, text: ctx.text, summaries: results.map((r) => r.summary), inverse: ctx.undoOf ? [] : inverse, at: Date.now(), agent }, focus)
  }

  private async meta(m: Extract<Parse, { kind: 'meta' }>, who: Principal, ctx: { messageId: string; text: string; turn: Turn }) {
    const convo = this.memory.get(who.id)
    switch (m.meta) {
      case 'help': return { reply: HELP, results: [] }
      case 'skills': return { reply: `${SKILLS.length} skills:\n` + SKILLS.map((s) => `• ${s.title}`).join('\n'), results: [] }
      case 'whoami': return { reply: `You're ${who.id} (${who.role}).`, results: [] }
      case 'history': {
        const h = convo.history.slice(-5).reverse()
        return { reply: h.length ? h.map((x) => `${new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${x.summaries.map((m) => m.split('\n')[0]).join('; ')}${x.undone ? ' (undone)' : ''}`).join('\n') : 'Nothing yet today.', results: [] }
      }
      case 'undo': {
        const last = [...convo.history].reverse().find((x) => !x.undone && x.inverse.length)
        if (!last) return { reply: "There's nothing I can undo.", results: [] }
        const r = await this.execute(last.inverse, who, { ...ctx, undoOf: last.messageId }, true)
        return { reply: r.results.every((x) => x.outcome !== 'failed') ? `Undid "${last.text}".\n${r.reply}` : r.reply, results: r.results }
      }
      case 'yes': return { reply: "There's nothing waiting on a yes.", results: [] }
      case 'no': return { reply: 'Okay.', results: [] }
      case 'choice': return { reply: "I wasn't asking a question — what do you need?", results: [] }
    }
  }
}

function secs(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s` }

export function format(results: StepResult[]): string {
  const lines = results.map((r) => {
    const skill = getSkill(r.step.skill)
    if (r.outcome === 'failed') {
      if (r.verification && !r.verification.ok) {
        const bad = r.verification.checks.find((c) => !c.ok)
        return `⚠️ ${r.summary} — but verification failed (${bad?.name}: expected ${JSON.stringify(bad?.expected)}, saw ${JSON.stringify(bad?.actual)}).`
      }
      return `Couldn't do it: ${r.summary}${r.hint ? ` ${r.hint}` : ''}`
    }
    if (r.outcome === 'denied') return r.summary
    if (r.outcome === 'noop') return r.summary
    if (skill?.risk === 'read') return r.summary
    const v = r.verification
    const tail = !v ? '' : v.level === 'durable' ? ` — verified ✓ (${secs(r.ms)})` : ` — confirmed on screen ✓ (${secs(r.ms)}; this sandbox screen doesn't persist it)`
    return `${r.summary}${tail}`
  })
  const writes = results.filter((r) => r.outcome === 'done' && getSkill(r.step.skill)?.risk !== 'read')
  if (lines.length === 1) return (writes.length ? 'Done. ' : '') + lines[0]
  return (writes.length === results.length ? 'Done:\n' : '') + lines.map((l) => `• ${l}`).join('\n')
}

const HELP = `I'm Donna — text me like you'd text a manager. Examples:
• "86 the nuggets" / "nuggets are back"
• "we're out of lamb chops and dolma"
• "raise all burgers 5%" · "wings are $18.99 now"
• "pause orders 30 min" · "resume orders"
• "accept order 8243" · "any new orders?"
• "add Mango Lassi to sides for $4.99"
• "add Ranch for 50 cents to wing sauce"
• "close on mondays" · "how are sales today"
• "morning brief" · "undo" · "history"
Every change is verified against the live dashboard before I reply.`
