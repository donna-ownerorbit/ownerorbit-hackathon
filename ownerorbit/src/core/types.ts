import type { z } from 'zod'
import type { Role } from '../config.ts'
import type { SandboxSession } from '../browser/session.ts'
import type { BxActor } from '../integrations/browser-exec.ts'

/* ---------- Sandbox data model (mirrors orders-dashboard/src/data.ts) ---------- */
export type Status = 'available' | 'sold_out_today' | 'sold_out' | 'hidden'
export const STATUSES: Status[] = ['available', 'sold_out_today', 'sold_out', 'hidden']
export const STATUS_LABEL: Record<Status, string> = {
  available: 'Available',
  sold_out_today: 'Sold out today',
  sold_out: 'Sold out indefinitely',
  hidden: 'Hidden',
}
export type OrderStatus = 'new' | 'preparing' | 'ready' | 'completed' | 'canceled'

export interface Item {
  id: string; categoryId: string; name: string; description: string; price: number; image?: string | null
  status: Status; tax: string; sizes: { id: string; name: string; price: number }[]; sku: string; unit: string
  stock: number; barcodes: string[]; trackInventory: boolean; modifierGroupIds: string[]; isNew?: boolean; orders30d: number
}
export interface Category { id: string; name: string; description: string; links: number; status: Status; collapsed?: boolean }
export interface ModifierGroup { id: string; name: string; min: number; max: number; required: boolean; options: { id: string; name: string; price: number }[] }
export interface Order {
  id: string; number: string; provider: string; customer: string; phone: string; type: string; status: OrderStatus
  placedAt: number; lines: { name: string; qty: number; price: number; note?: string }[]; subtotal: number; tax: number; tip: number; total: number
}

export const STORES = [
  { id: 'hayward', name: 'Falafel Flare Hayward' },
  { id: 'fremont', name: 'Falafel Flare Fremont' },
  { id: 'sanleandro', name: 'Falafel Flare San Leandro' },
]
export const PROVIDERS = ['Online Ordering Website', 'DoorDash', 'Uber Eats', 'Grubhub']

/** Ground truth read back out of the sandbox (its DB via /api/state, or its persisted browser store). */
export interface Snapshot {
  mode: 'db' | 'local'
  readAt: number
  restaurant: { storeId: string; accepting: boolean; pausedUntil: number | null; menuSyncedAt: number }
  categories: Category[]
  items: Item[]
  modifierGroups: ModifierGroup[]
  orders: Order[]
}

/* ---------- Skills ---------- */
export type Risk = 'read' | 'write' | 'destructive'

/** How strongly a result was verified. durable = re-read from persisted sandbox state after a full reload. */
export type VerifyLevel = 'durable' | 'session' | 'none'

export interface Check { name: string; expected: unknown; actual: unknown; ok: boolean }
export interface Verification { ok: boolean; level: VerifyLevel; checks: Check[] }

export interface SkillContext {
  session: SandboxSession
  /** Snapshot taken right before run(). */
  before: Snapshot
  log: (msg: string, data?: unknown) => void
  /** Who asked and which action this is (lets a skill delegate to browser-exec with the same identity/run id). */
  actor?: BxActor
}

export interface RunOutput {
  /** One-line, text-message-sized result. */
  summary: string
  /** Free-form details stored with the evidence. */
  data?: unknown
  /** Number of sandbox entities touched (drives bulk confirmation + reporting). */
  touched?: number
}

export interface PlanStep { skill: string; input: Record<string, unknown>; /** Human gloss used in confirmations. */ why?: string }

export interface Skill<I extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  title: string
  description: string
  domain: 'menu' | 'store' | 'orders' | 'insights' | 'schedule' | 'chargebacks'
  risk: Risk
  /** Minimum role allowed to run it. */
  minRole: Role
  input: z.ZodType<I>
  /** Example owner texts; used by /help, the LLM planner prompt, and parser tests. */
  examples: string[]
  /** Return a reason string if the step needs an explicit YES (beyond risk === 'destructive'). */
  confirm?: (input: I, snap: Snapshot) => string | null
  /** Return a summary if the sandbox already satisfies the request (idempotent no-op). */
  alreadyDone?: (input: I, snap: Snapshot) => string | null
  /** Validate the request against current state; throw SkillError with a helpful message if impossible. */
  precheck?: (input: I, snap: Snapshot) => void
  run: (ctx: SkillContext, input: I) => Promise<RunOutput>
  /** Re-read the sandbox (after a reload) and prove the change landed. Read skills omit this. */
  /** The sandbox keeps this state in component memory only, so verify on-screen without a reload. */
  sessionOnly?: boolean
  verify?: (ctx: SkillContext & { after: Snapshot; output: RunOutput }, input: I) => Promise<Verification> | Verification
  /** Plan that reverses this step, computed from the pre-run snapshot. */
  inverse?: (input: I, before: Snapshot, output: RunOutput) => PlanStep[] | null
}

export class SkillError extends Error {
  constructor(message: string, public hint?: string) { super(message) }
}

export const ROLE_RANK: Record<Role, number> = { staff: 0, manager: 1, owner: 2 }
