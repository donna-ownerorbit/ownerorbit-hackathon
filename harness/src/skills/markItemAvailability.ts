export interface SkillResult {
  ok: boolean;
  verified: boolean;
  status?: string;
  detail?: string;
  traceId?: string;
}

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

/**
 * Calls browser-exec (../browser-exec) POST /execute, which runs the Playwright skill,
 * re-reads the menu on a fresh page and returns VERIFIED / ALREADY_DONE only when it's really done.
 * SKILL_URL is the browser-exec base URL (default http://localhost:4001).
 */
export async function markItemAvailability(params: {
  itemName: string;
  available: boolean;
  runId: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  permissions: string[];
  message: string;
}): Promise<SkillResult> {
  const base = (process.env.SKILL_URL || "http://localhost:4001").replace(/\/$/, "");
  const res = await fetch(`${base}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: params.runId,
      idempotencyKey: `exec:${params.idempotencyKey}`,
      tenantId: params.tenantId,
      actor: { userId: params.userId, role: "OWNER", permissions: params.permissions },
      skillId: params.available ? "middleware.mark_item_available" : "middleware.mark_item_unavailable",
      inputs: { itemId: resolveItemId(params.itemName) },
      message: params.message,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
  const verified = body.status === "VERIFIED" || body.status === "ALREADY_DONE";
  return { ok: res.ok && verified, verified, status: body.status, detail: body.message, traceId: params.runId };
}
