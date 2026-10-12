import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { config, type Role } from '../config.ts'
import type { SandboxSession } from '../browser/session.ts'
import { closeOverlays } from '../browser/ui.ts'
import { getSkill } from '../skills/index.ts'
import { evidence, type ActionRecord } from '../telemetry/evidence.ts'
import type { Turn } from '../telemetry/tracing.ts'
import { ROLE_RANK, SkillError, type PlanStep, type RunOutput, type Skill, type Snapshot, type Verification } from './types.ts'

export interface StepResult {
  step: PlanStep
  actionId: string
  outcome: ActionRecord['outcome']
  summary: string
  verification?: Verification
  inverse?: PlanStep[] | null
  ms: number
  error?: string
  hint?: string
  attempts?: number
  /** Skill output data (e.g. which backend ran it, browser-exec statuses). */
  data?: unknown
}

export interface Principal { id: string; role: Role }

/** Everything that would make us ask before acting, evaluated against live state. */
export interface Preflight { blocked: StepResult[]; confirmations: string[] }

const stateKey = (s: Snapshot) => JSON.stringify({ r: s.restaurant, c: s.categories, i: s.items, m: s.modifierGroups, o: s.orders.map((o) => [o.id, o.status]) })

export class Executor {
  constructor(private session: SandboxSession) {}

  private parse(step: PlanStep): { skill: Skill; input: Record<string, unknown> } | { error: string } {
    const skill = getSkill(step.skill)
    if (!skill) return { error: `Unknown skill ${step.skill}` }
    const r = skill.input.safeParse(step.input)
    if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') }
    return { skill, input: r.data }
  }

  /** Permission + validation + confirmation needs for a whole plan, before anything runs. */
  async preflight(plan: PlanStep[], who: Principal): Promise<Preflight> {
    const out: Preflight = { blocked: [], confirmations: [] }
    const snap = await this.session.exclusive(() => this.session.readTruth())
    for (const step of plan) {
      const p = this.parse(step)
      const fail = (outcome: ActionRecord['outcome'], summary: string, hint?: string) => out.blocked.push({ step, actionId: randomUUID(), outcome, summary, ms: 0, hint })
      if ('error' in p) { fail('failed', `I couldn't do that: ${p.error}`); continue }
      if (ROLE_RANK[who.role] < ROLE_RANK[p.skill.minRole]) { fail('denied', `${p.skill.title} needs ${p.skill.minRole} access (you're ${who.role}).`); continue }
      try {
        p.skill.precheck?.(p.input, snap)
        if (p.skill.alreadyDone?.(p.input, snap)) continue
        const reason = p.skill.confirm?.(p.input, snap) ?? (p.skill.risk === 'destructive' ? `${p.skill.title}: this can't be fully undone.` : null)
        if (reason) out.confirmations.push(reason)
      } catch (e) {
        if (e instanceof SkillError) fail('failed', e.message, e.hint)
        else throw e
      }
    }
    if (plan.length > 1 && plan.length > config.bulkConfirmThreshold) out.confirmations.push(`That's ${plan.length} separate changes.`)
    return out
  }

  async runPlan(plan: PlanStep[], who: Principal, ctx: { messageId: string; text: string; turn: Turn; undoOf?: string }): Promise<StepResult[]> {
    const results: StepResult[] = []
    for (const [n, step] of plan.entries()) {
      const r = await ctx.turn.tool(step.skill, step.input, () => this.runStep(step, who, ctx, `${n + 1}/${plan.length}`))
      results.push(r)
      if (r.outcome === 'failed') break // later steps may depend on this one
    }
    return results
  }

  private async runStep(step: PlanStep, who: Principal, ctx: { messageId: string; text: string; turn: Turn; undoOf?: string }, pos: string): Promise<StepResult> {
    const actionId = randomUUID()
    const t0 = Date.now()
    const dir = join(config.dataDir, 'evidence', actionId)
    const rec: ActionRecord = {
      actionId, messageId: ctx.messageId, principal: who.id, role: who.role, skill: step.skill, input: step.input,
      outcome: 'failed', summary: '', attempts: 0, timings: { startedAt: new Date(t0).toISOString(), totalMs: 0 },
      sandbox: { url: this.session.url, apiMode: this.session.apiMode }, artifacts: {}, undoOf: ctx.undoOf, at: new Date(),
    }
    const finish = async (r: Omit<StepResult, 'step' | 'actionId' | 'ms'>): Promise<StepResult> => {
      rec.outcome = r.outcome; rec.summary = r.summary; rec.error = r.error; rec.verification = r.verification
      rec.timings.totalMs = Date.now() - t0
      await evidence.action(rec).catch((e) => console.warn('[evidence]', e.message))
      if (r.outcome === 'failed') ctx.turn.signal('step_failed', 'NEGATIVE', { skill: step.skill, error: r.error ?? r.summary })
      if (r.verification) ctx.turn.signal(r.verification.ok ? 'verified' : 'verification_failed', r.verification.ok ? 'POSITIVE' : 'NEGATIVE', { skill: step.skill, level: r.verification.level })
      return { step, actionId, ms: rec.timings.totalMs, attempts: rec.attempts, ...r }
    }

    const p = this.parse(step)
    if ('error' in p) return finish({ outcome: 'failed', summary: `I couldn't do that: ${p.error}`, error: p.error })
    const { skill, input } = p
    if (ROLE_RANK[who.role] < ROLE_RANK[skill.minRole]) return finish({ outcome: 'denied', summary: `${skill.title} needs ${skill.minRole} access.` })

    return this.session.exclusive(async (page) => {
      const s = this.session
      const log = (m: string, d?: unknown) => console.log(`  [${skill.id}] ${m}`, d ?? '')
      let before = await s.readTruth()
      rec.sandbox.mode = before.mode
      try {
        skill.precheck?.(input, before)
        const already = skill.alreadyDone?.(input, before)
        if (already) return finish({ outcome: 'noop', summary: already })
      } catch (e) {
        if (e instanceof SkillError) return finish({ outcome: 'failed', summary: e.message, error: e.message, hint: e.hint })
        throw e
      }

      await s.say(ctx.text, `${pos} · ${skill.title}…`)
      await s.startTrace()
      rec.artifacts.before = await s.shot(dir, 'before')
      let output: RunOutput | null = null
      let lastErr: Error | null = null
      const tRun = Date.now()
      for (let attempt = 1; attempt <= 2 && !output; attempt++) {
        rec.attempts = attempt
        try {
          output = await skill.run({ session: s, before, log, actor: { id: who.id, role: who.role, messageId: ctx.messageId, text: ctx.text, actionId } }, input)
        } catch (e) {
          lastErr = e as Error
          if (e instanceof SkillError) break
          log(`attempt ${attempt} failed: ${lastErr.message.split('\n')[0]}`)
          // Retry only if the sandbox is provably untouched; never double-apply a change.
          await closeOverlays(page).catch(() => undefined)
          await s.reload().catch(() => undefined)
          const now = await s.readTruth().catch(() => null)
          if (!now) break
          if (skill.alreadyDone?.(input, now)) { output = { summary: skill.alreadyDone(input, now)!, touched: 0 }; break }
          if (stateKey(now) !== stateKey(before)) break
          before = now
        }
      }
      rec.timings.runMs = Date.now() - tRun
      if (!output) {
        rec.artifacts.after = await s.shot(dir, 'failure')
        rec.artifacts.trace = await s.stopTrace(join(dir, 'trace.zip'))
        await s.say(ctx.text, `✗ ${skill.title} failed`, 'fail')
        const msg = lastErr instanceof SkillError ? lastErr.message : `${skill.title} failed in the dashboard: ${(lastErr?.message ?? 'unknown').split('\n')[0]}`
        return finish({ outcome: 'failed', summary: msg, error: lastErr?.message, hint: lastErr instanceof SkillError ? lastErr.hint : undefined })
      }

      // Verify: let the write land, then (for persisted state) reload and re-read ground truth from scratch.
      let verification: Verification | undefined
      if (skill.verify) {
        await s.say(ctx.text, `${pos} · verifying against live sandbox state…`)
        const tV = Date.now()
        try {
          if (!skill.sessionOnly) {
            await s.waitForTruth((x) => stateKey(x) !== stateKey(before), 4000)
            await s.reload()
          }
          const after = await s.readTruth()
          verification = await skill.verify({ session: s, before, after, output, log }, input)
        } catch (e) {
          verification = { ok: false, level: 'none', checks: [{ name: 'verify', expected: 'ran', actual: (e as Error).message.split('\n')[0], ok: false }] }
        }
        rec.timings.verifyMs = Date.now() - tV
      }
      rec.artifacts.after = await s.shot(dir, 'after')
      rec.artifacts.trace = await s.stopTrace(join(dir, 'trace.zip'))
      rec.touched = output.touched
      const ok = !verification || verification.ok
      await s.say(ctx.text, `${ok ? '✓' : '✗'} ${output.summary}${verification ? (ok ? ' — verified' : ' — verification FAILED') : ''}`, ok ? 'ok' : 'fail')
      const inverse = skill.inverse?.(input, before, output) ?? null
      rec.beforeState = inverse
      return finish({
        outcome: ok ? (output.touched === 0 && skill.risk !== 'read' ? 'noop' : 'done') : 'failed',
        summary: output.summary, verification, inverse, data: output.data,
        error: ok ? undefined : 'verification failed: ' + verification!.checks.filter((c) => !c.ok).map((c) => `${c.name} expected ${JSON.stringify(c.expected)} got ${JSON.stringify(c.actual)}`).join('; '),
      })
    })
  }

  async snapshot() { return this.session.exclusive(() => this.session.readTruth()) }
}
