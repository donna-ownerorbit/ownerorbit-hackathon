/** Owner phrasing -> OrderDesk item id. Unknown names fall back to a slug of the text. */
const ITEM_ALIASES: Record<string, string> = {
  nuggets: "kids-chicken-nuggets-with-fries",
  nugs: "kids-chicken-nuggets-with-fries",
  "chicken nuggets": "kids-chicken-nuggets-with-fries",
  "kids chicken nuggets": "kids-chicken-nuggets-with-fries",
  "kids chicken nuggets with fries": "kids-chicken-nuggets-with-fries",
};

export function resolveItemId(itemName: string): string {
  const key = itemName.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9 ]/g, "").trim();
  return ITEM_ALIASES[key] ?? key.replace(/\s+/g, "-");
}

/** Mirrors browser-exec's ExecuteResult (browser-exec/src/skills/types.ts). */
export interface ExecuteResult {
  status: "VERIFIED" | "ALREADY_DONE" | "FAILED" | "NEEDS_HUMAN" | "NEEDS_APPROVAL";
  message: string;
  before?: { name?: string; price?: number; status?: string };
  after?: { name?: string; price?: number; status?: string };
}

export interface ExecuteParams {
  runId: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  permissions: string[];
  skillId: string;
  inputs: Record<string, unknown>;
  approvalId?: string;
  message: string;
}

/**
 * Calls browser-exec (../browser-exec) POST /execute, which runs the Playwright skill,
 * re-reads the menu on a fresh page and returns VERIFIED / ALREADY_DONE only when it's really done.
 * SKILL_URL is the browser-exec base URL (default http://localhost:4001).
 */
export async function executeSkill(p: ExecuteParams): Promise<ExecuteResult> {
  const base = (process.env.SKILL_URL || "http://localhost:4001").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: p.runId,
        idempotencyKey: p.idempotencyKey,
        tenantId: p.tenantId,
        actor: { userId: p.userId, role: "OWNER", permissions: p.permissions },
        skillId: p.skillId,
        inputs: p.inputs,
        approvalId: p.approvalId,
        message: p.message,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json().catch(() => null)) as ExecuteResult | null;
    return body?.status ? body : { status: "FAILED", message: `browser-exec HTTP ${res.status}` };
  } catch (err) {
    return { status: "FAILED", message: `browser-exec unreachable: ${(err as Error).message}` };
  }
}

export const isSuccess = (r: ExecuteResult) => r.status === "VERIFIED" || r.status === "ALREADY_DONE";
