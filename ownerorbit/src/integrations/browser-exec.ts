import { config, type Role } from '../config.ts'

/**
 * Client for browser-exec (team repo main → browser-exec/, Abdullah's track): deterministic Playwright
 * skills with their own idempotency, independent re-read, provider-consistency check, Raindrop trace
 * + evals, and action_runs/audit_events in the same Atlas DB.
 *
 * OwnerOrbit stays the brain (identity, RBAC, approvals, planning); browser-exec is one execution
 * backend. Skills whose operation it covers delegate to it when it's reachable, and OwnerOrbit still
 * runs its own verification afterwards, so a change is proven twice by two independent readers.
 */

export type BxStatus = 'VERIFIED' | 'ALREADY_DONE' | 'FAILED' | 'NEEDS_HUMAN' | 'NEEDS_APPROVAL'
export interface BxResult {
  status: BxStatus; message: string; attempts: number; evidence: string[]
  before?: { name?: string; status?: string; price?: number }; after?: { name?: string; status?: string; price?: number }
  confirmation?: { status: 'CONSISTENT' | 'INCONSISTENT' | string; pushed?: boolean; checks: { provider: string; ok: boolean }[] }
}
export interface BxActor { id: string; role: Role; messageId: string; text: string; actionId: string }

/** Thrown when browser-exec can't be reached: the caller falls back to the built-in skill. */
export class BxUnavailable extends Error {}

const ROLE: Record<Role, 'OWNER' | 'MANAGER' | 'EMPLOYEE'> = { owner: 'OWNER', manager: 'MANAGER', staff: 'EMPLOYEE' }
// Mirrors OwnerOrbit's own RBAC (skill minRole); browser-exec re-checks as defense in depth.
const PERMISSIONS: Record<Role, string[]> = {
  owner: ['menu.write', 'pricing.write', 'objectives.manage'],
  manager: ['menu.write', 'pricing.write'],
  staff: ['menu.write'],
}

let health: { ok: boolean; skills: string[]; at: number } | null = null

export async function bxAvailable(skillId?: string): Promise<boolean> {
  if (!config.browserExecUrl) return false
  if (!health || Date.now() - health.at > 20_000) {
    try {
      const r = await fetch(`${config.browserExecUrl}/health`, { signal: AbortSignal.timeout(2500) })
      const j = (await r.json()) as { skills?: string[] }
      health = { ok: r.ok, skills: j.skills ?? [], at: Date.now() }
    } catch {
      health = { ok: false, skills: [], at: Date.now() }
    }
  }
  return health.ok && (!skillId || health.skills.includes(skillId))
}

export async function bxExecute(skillId: string, inputs: Record<string, unknown>, actor: BxActor, opts: { approvalId?: string; key?: string } = {}): Promise<BxResult> {
  if (!(await bxAvailable(skillId))) throw new BxUnavailable(`browser-exec unavailable for ${skillId}`)
  let res: Response
  try {
    res = await fetch(`${config.browserExecUrl}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        runId: actor.actionId,
        // One key per (action, skill, item): retries of the same step never execute twice over there either.
        idempotencyKey: opts.key ?? `${actor.actionId}:${skillId}:${JSON.stringify(inputs)}`,
        tenantId: config.restaurantId,
        actor: { userId: actor.id, role: ROLE[actor.role], permissions: PERMISSIONS[actor.role] },
        skillId, inputs, approvalId: opts.approvalId, message: actor.text.slice(0, 2000),
      }),
    })
  } catch (e) {
    health = null
    throw new BxUnavailable((e as Error).message)
  }
  if (!res.ok && res.status !== 500) throw new BxUnavailable(`browser-exec HTTP ${res.status}`)
  return (await res.json()) as BxResult
}

export const bxSucceeded = (r: BxResult) => r.status === 'VERIFIED' || r.status === 'ALREADY_DONE'

/** One line for the owner's reply, e.g. "browser-exec ✓ verified · providers consistent". */
export function bxNote(r: BxResult) {
  const c = r.confirmation
  return `browser-exec ${bxSucceeded(r) ? '✓' : '✗'} ${r.status.toLowerCase().replace('_', ' ')}${c ? ` · providers ${c.status === 'CONSISTENT' ? 'consistent' : 'out of sync: ' + c.checks.filter((x) => !x.ok).map((x) => x.provider).join(', ')}` : ''}`
}
