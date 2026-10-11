import type { Page } from "playwright";
import type { z } from "zod";
import { z as schema } from "zod";

export type Role = "OWNER" | "GM" | "MANAGER" | "EMPLOYEE";

export interface Skill<I = any, S = any> {
  id: string;
  version: number;
  requiredPermission: string;     // checked again here as defense in depth
  requiresApproval: (input: I, before: S) => boolean;
  inputs: z.ZodType<I>;
  read: (page: Page, input: I) => Promise<S>;          // observe current state
  isDone: (state: S, input: I, before?: S) => boolean; // desired state reached?
  execute: (page: Page, input: I) => Promise<void>;    // do the change
  // What downstream providers should show after this change (drives the confirmation agent)
  expected?: (input: I) => { available?: boolean; price?: number };
}

// Contract with the harness (Ash). Auth + RBAC already passed before this.
export interface ExecuteRequest {
  runId: string;
  idempotencyKey: string;
  tenantId: string;
  actor: { userId: string; role: Role; permissions: string[] };
  skillId: string;
  inputs: Record<string, unknown>;
  approvalId?: string;
  message?: string;               // owner's original text, for traces/evals only (optional)
}

export const executeRequestSchema = schema.object({
  runId: schema.string().min(1).refine((s) => s.trim().length > 0, "runId cannot be blank"),
  idempotencyKey: schema.string().min(1).refine((s) => s.trim().length > 0, "idempotencyKey cannot be blank"),
  tenantId: schema.string().min(1).refine((s) => s.trim().length > 0, "tenantId cannot be blank"),
  actor: schema.object({
    userId: schema.string().trim().min(1),
    role: schema.enum(["OWNER", "GM", "MANAGER", "EMPLOYEE"]),
    permissions: schema.array(schema.string()),
  }),
  skillId: schema.string().min(1),
  inputs: schema.record(schema.unknown()),
  approvalId: schema.string().trim().min(1).optional(),
  message: schema.string().max(2000).optional(),
});

export interface ExecuteResult {
  status: "VERIFIED" | "ALREADY_DONE" | "FAILED" | "NEEDS_HUMAN" | "NEEDS_APPROVAL";
  message: string;
  before?: unknown;
  after?: unknown;
  evidence: string[];
  attempts: number;
  confirmation?: import("../confirmation/confirm.js").ConfirmationResult;
}
