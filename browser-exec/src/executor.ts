import { MongoClient, type Collection } from "mongodb";
import { registry } from "./skills/menuSkills.js";
import type { ExecuteRequest, ExecuteResult } from "./skills/types.js";
import { executeRequestSchema } from "./skills/types.js";
import { newPage, screenshot, NeedsHuman, withBrowserLock } from "./tools/middlewareBrowser.js";
import { trace } from "./trace.js";
import { confirmAcrossProviders } from "./confirmation/confirm.js";

let runs: Collection | null = null;
let audit: Collection | null = null;
let connecting: Promise<{ runs: Collection; audit: Collection }> | null = null;

// No MONGODB_URI yet? Use an in-memory stand-in so the browser work isn't blocked on Atlas.
function memoryCollections(): { runs: Collection; audit: Collection } {
  const docs = new Map<string, any>();
  const events: any[] = [];
  const r = {
    findOne: async (q: any) => docs.get(q.idempotencyKey) ?? null,
    insertOne: async (d: any) => {
      if (docs.has(d.idempotencyKey)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      docs.set(d.idempotencyKey, d);
    },
    updateOne: async (q: any, u: any) => docs.set(q.idempotencyKey, { ...(docs.get(q.idempotencyKey) ?? q), ...u.$set }),
  };
  const a = { insertOne: async (e: any) => { events.push(e); console.log("[audit]", e.event); } };
  return { runs: r as unknown as Collection, audit: a as unknown as Collection };
}

async function db() {
  if (runs) return { runs, audit: audit! };
  if (connecting) return connecting;
  if (!process.env.MONGODB_URI) {
    console.warn("MONGODB_URI not set — using in-memory store (nothing persisted)");
    ({ runs, audit } = memoryCollections());
    return { runs: runs!, audit: audit! };
  }
  connecting = (async () => {
    const client = await new MongoClient(process.env.MONGODB_URI!).connect();
    try {
      const d = client.db(process.env.MONGODB_DB || "ownerorbit");
      const actionRuns = d.collection(process.env.MONGODB_RUNS_COLLECTION || "action_runs");
      const auditEvents = d.collection(process.env.MONGODB_AUDIT_COLLECTION || "audit_events");
      await actionRuns.createIndex({ idempotencyKey: 1 }, { unique: true });
      await actionRuns.createIndex({ tenantId: 1, startedAt: -1 });
      await auditEvents.createIndex({ tenantId: 1, ts: -1 });
      await auditEvents.createIndex({ runId: 1, ts: 1 });
      runs = actionRuns;
      audit = auditEvents;
      return { runs, audit };
    } catch (e) {
      await client.close();
      throw e;
    }
  })();
  try { return await connecting; } finally { connecting = null; }
}

// One browser action per tenant at a time.
const locks = new Map<string, Promise<unknown>>();
function withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(tenantId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => {});
  locks.set(tenantId, settled);
  void settled.then(() => { if (locks.get(tenantId) === settled) locks.delete(tenantId); });
  return next;
}

const MAX_ATTEMPTS = 2;

export async function execute(req: ExecuteRequest): Promise<ExecuteResult> {
  const request = executeRequestSchema.safeParse(req);
  if (!request.success) return { status: "FAILED", message: `Bad request: ${request.error.message}`, evidence: [], attempts: 0 };
  req = request.data;
  const { runs, audit } = await db();
  const log = (event: string, data: object = {}) =>
    audit.insertOne({ ts: new Date(), runId: req.runId, tenantId: req.tenantId, actor: req.actor.userId, event, ...data });

  // 1. Idempotency: same key → return the stored result, never re-execute.
  const existing = await runs.findOne({ idempotencyKey: req.idempotencyKey });
  if (existing?.result) return existing.result as ExecuteResult;

  // Reserve the key before any validation result can overwrite an in-flight run.
  try {
    await runs.insertOne({ idempotencyKey: req.idempotencyKey, runId: req.runId, tenantId: req.tenantId, skillId: req.skillId, inputs: req.inputs, status: "RUNNING", startedAt: new Date() });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    const duplicate = await runs.findOne({ idempotencyKey: req.idempotencyKey });
    return duplicate?.result ?? { status: "FAILED", message: "Duplicate request already in progress", evidence: [], attempts: 0 };
  }

  const skill = Object.hasOwn(registry, req.skillId) ? registry[req.skillId] : undefined;
  if (!skill) return done({ status: "FAILED", message: `Unknown skill ${req.skillId}`, evidence: [], attempts: 0 });

  // 2. Defense in depth: RBAC already ran upstream, but re-check the permission here.
  if (!req.actor.permissions.includes(skill.requiredPermission))
    return done({ status: "FAILED", message: `Missing permission ${skill.requiredPermission}`, evidence: [], attempts: 0 });

  const parsed = skill.inputs.safeParse(req.inputs);
  if (!parsed.success)
    return done({ status: "FAILED", message: `Bad inputs: ${parsed.error.message}`, evidence: [], attempts: 0 });
  const input = parsed.data;

  await runs.updateOne({ idempotencyKey: req.idempotencyKey }, { $set: { skillVersion: skill.version, inputs: input } });
  await log("execution.started", { skillId: skill.id, inputs: input });

  return withTenantLock(req.tenantId, () => withBrowserLock(() =>
    trace(req, skill, async (span) => {
      let page: Awaited<ReturnType<typeof newPage>> | undefined;
      const evidence: string[] = [];
      let attempts = 0;
      try {
        page = await newPage();
        const actionPage = page;
        // 3. Read current state first (natural idempotency + "before" snapshot for rollback).
        const before = await span("read_before", () => skill.read(actionPage, input));
        if (skill.isDone(before, input))
          return await done({ status: "ALREADY_DONE", message: "Already in the requested state.", before, after: before, evidence: [await screenshot(page, "already")], attempts });

        // 4. Approval gate (price changes etc.)
        if (skill.requiresApproval(input, before) && !req.approvalId)
          return await done({ status: "NEEDS_APPROVAL", message: "Owner approval required.", before, evidence, attempts });

        // 5. Execute with retry. Always re-read before retrying — attempt 1 may have half-succeeded.
        let after: any = before;
        const changedAt = Date.now();
        while (attempts < MAX_ATTEMPTS) {
          attempts++;
          try {
            await span(`execute_${attempts}`, () => skill.execute(actionPage, input));
          } catch (e) {
            if (e instanceof NeedsHuman) throw e;
            evidence.push(await screenshot(page, `error-${attempts}`));
            await log("execution.attempt_failed", { attempts, error: String(e) });
          }
          // 6. Independent verification: fresh page, reload, compare desired vs observed.
          let verified = false;
          const vPage = await newPage();
          try {
            verified = await span(`verify_${attempts}`, async () => {
              after = await skill.read(vPage, input);
              if (!skill.isDone(after, input, before)) throw new Error("Observed state does not match the requested change");
              return true;
            });
            evidence.push(await screenshot(vPage, `verify-${attempts}`));
          } catch (e) {
            if (e instanceof NeedsHuman) throw e;
            evidence.push(await screenshot(vPage, `verify-error-${attempts}`).catch(() => ""));
            await log("execution.verification_failed", { attempts, error: String(e) });
          } finally {
            await vPage.close().catch(() => {});
          }
          if (verified) {
            // 7. Confirmation agent: are DoorDash / Uber Eats / Grubhub consistent with the middleware?
            if (!skill.expected) return await done({ status: "VERIFIED", message: "Done. Verified.", before, after, evidence, attempts });
            const toView = (s: any) => ({ available: s.status === "available", price: s.price });
            const confirmation = await confirmAcrossProviders(
              page,
              { itemId: after.itemId, name: after.name, before: toView(before), current: toView(after), changedAt },
              { ...toView(after), ...skill.expected(input) },
              { autoPush: true, span },
            );
            evidence.push(...confirmation.evidence);
            const bad = confirmation.checks.filter((c) => !c.ok).map((c) => c.provider);
            const message = confirmation.status === "CONSISTENT"
              ? `Done. Verified in OrderDesk and consistent on ${confirmation.checks.map((c) => c.provider).join(", ")}.`
              : `Changed and verified in OrderDesk, but NOT consistent on: ${bad.join(", ")}.`;
            return await done({ status: "VERIFIED", message, before, after, evidence, attempts, confirmation });
          }
        }
        return await done({ status: "NEEDS_HUMAN", message: "Could not verify the change after retries.", before, after, evidence, attempts });
      } catch (e) {
        if (page) {
          const path = await screenshot(page, "fatal").catch(() => "");
          if (path) evidence.push(path);
        }
        const status = e instanceof NeedsHuman || page ? "NEEDS_HUMAN" : "FAILED";
        return await done({ status, message: String((e as Error).message), evidence, attempts });
      } finally {
        await page?.close().catch(() => {});
      }
    })),
  );

  async function done(result: ExecuteResult): Promise<ExecuteResult> {
    result.evidence = result.evidence.filter(Boolean);
    await runs.updateOne(
      { idempotencyKey: req.idempotencyKey },
      { $set: { status: result.status, result, finishedAt: new Date() } },
      { upsert: true },
    );
    await log(`execution.${result.status.toLowerCase()}`, { before: result.before, after: result.after, evidence: result.evidence, attempts: result.attempts, confirmation: result.confirmation });
    return result;
  }
}
