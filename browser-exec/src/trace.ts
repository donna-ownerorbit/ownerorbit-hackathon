// Tracing + evals → Raindrop (https://www.raindrop.ai/docs/sdk/typescript)
//
// One Raindrop interaction per executed request:
//   input  = the owner's message (or the skill + inputs)
//   output = the reply we send back to the owner
//   properties = skill id/version, tenant, status, item, per-step timings, provider results
// Evals = deterministic checks on each run, sent as Raindrop signals on that interaction.
// If RAINDROP_WRITE_KEY is not set, everything still works and only logs to the console.
import { Raindrop } from "raindrop-ai";
import type { ExecuteRequest, ExecuteResult } from "./skills/types.js";

const raindrop = process.env.RAINDROP_WRITE_KEY
  ? new Raindrop({ writeKey: process.env.RAINDROP_WRITE_KEY, debugLogs: process.env.RAINDROP_DEBUG === "true" })
  : null;

export type SpanFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
interface Span { name: string; ms: number; ok: boolean; error?: string }

export interface EvalResult { name: string; pass: boolean; detail: string }

// ---- Evals: plain code, no LLM judge -------------------------------------------------
export function runEvals(result: ExecuteResult, spans: Span[], totalMs: number): EvalResult[] {
  const verifyPassed = spans.some((s) => s.name.startsWith("verify") && s.ok);
  const claimedSuccess = result.status === "VERIFIED" || result.status === "ALREADY_DONE";
  const evals: EvalResult[] = [
    {
      // THE key eval: we never told the owner "Done" unless an independent re-read confirmed it.
      name: "honest_claim",
      pass: !claimedSuccess || verifyPassed || (result.status === "ALREADY_DONE" && spans.some((s) => s.name === "read_before" && s.ok)),
      detail: `status=${result.status} verifyPassed=${verifyPassed}`,
    },
    { name: "task_completed", pass: claimedSuccess, detail: result.status },
    { name: "first_try", pass: result.attempts <= 1, detail: `attempts=${result.attempts}` },
    { name: "fast_enough", pass: totalMs < 15_000, detail: `${totalMs}ms` },
  ];
  if (result.confirmation) {
    const bad = result.confirmation.checks.filter((c) => !c.ok).map((c) => c.provider);
    evals.push({
      name: "providers_consistent",
      pass: result.confirmation.status === "CONSISTENT",
      detail: bad.length ? `inconsistent: ${bad.join(", ")}` : `pushed=${result.confirmation.pushed}`,
    });
  }
  return evals;
}

// ---- Trace wrapper used by the executor ----------------------------------------------
export async function trace(
  req: ExecuteRequest,
  skill: { id: string; version: number },
  fn: (span: SpanFn) => Promise<ExecuteResult>,
): Promise<ExecuteResult> {
  const spans: Span[] = [];
  const started = Date.now();
  const span: SpanFn = async (name, f) => {
    const t = Date.now();
    try {
      const r = await f();
      spans.push({ name, ms: Date.now() - t, ok: true });
      return r;
    } catch (e) {
      spans.push({ name, ms: Date.now() - t, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
      throw e;
    }
  };

  const interaction = raindrop?.begin({
    eventId: req.runId,
    event: "skill_execution",
    userId: req.actor.userId,
    input: req.message ?? `${skill.id} ${JSON.stringify(req.inputs)}`,
    properties: {
      skill_id: skill.id,
      skill_version: skill.version,
      tenant_id: req.tenantId,
      actor_role: req.actor.role,
      inputs: JSON.stringify(req.inputs),
    },
  });

  let result: ExecuteResult;
  try {
    result = await fn(span);
  } catch (e) {
    result = { status: "FAILED", message: String(e), evidence: [], attempts: 0 };
  }
  const totalMs = Date.now() - started;
  const evals = runEvals(result, spans, totalMs);

  console.log(JSON.stringify({ trace: req.runId, skill: `${skill.id}@v${skill.version}`, status: result.status, totalMs, spans, evals }));

  if (raindrop && interaction) {
    try {
      interaction.setProperties({
        status: result.status,
        attempts: result.attempts,
        total_ms: totalMs,
        spans: JSON.stringify(spans),
        providers: JSON.stringify(result.confirmation?.checks ?? []),
        evals_passed: evals.filter((e) => e.pass).length,
        evals_total: evals.length,
      });
      interaction.addAttachments([
        { type: "text", name: "Before", value: JSON.stringify(result.before ?? null, null, 2), role: "input" },
        { type: "text", name: "After (fresh re-read)", value: JSON.stringify(result.after ?? null, null, 2), role: "output" },
        { type: "text", name: "Evals", value: evals.map((e) => `${e.pass ? "PASS" : "FAIL"}  ${e.name}  (${e.detail})`).join("\n"), role: "output" },
      ]);
      await interaction.finish({ output: result.message });

      // Evals as signals on this run
      raindrop.trackSignal(
        evals.map((e) => ({
          eventId: req.runId,
          name: `eval_${e.name}_${e.pass ? "pass" : "fail"}`,
          type: "agent_internal" as const,
          sentiment: e.pass ? ("POSITIVE" as const) : ("NEGATIVE" as const),
          properties: { eval: e.name, pass: e.pass, detail: e.detail, skill_id: skill.id, skill_version: skill.version },
        })),
      );

      // Self-diagnosis for failures so Raindrop groups them as issues
      if (result.status === "NEEDS_HUMAN" || result.status === "FAILED") {
        const failedStep = spans.find((s) => !s.ok);
        raindrop.selfDiagnose({
          eventId: req.runId,
          description: `${skill.id}@v${skill.version} could not complete/verify: ${result.message}${failedStep ? ` (failed step: ${failedStep.name}: ${failedStep.error})` : ""}`,
          category: failedStep?.name.startsWith("execute") || failedStep?.name.startsWith("verify") ? "repeatedly_broken_tool" : "complete_task_failure",
          source: "ownerorbit-browser-exec",
          properties: { skill_id: skill.id, skill_version: skill.version },
        });
      }
      if (result.confirmation?.status === "INCONSISTENT") {
        raindrop.selfDiagnose({
          eventId: req.runId,
          description: `Providers out of sync after verified change: ${result.confirmation.checks.filter((c) => !c.ok).map((c) => c.provider).join(", ")}`,
          category: "provider_inconsistency",
          source: "ownerorbit-confirmation",
        });
      }
    } catch (e) {
      console.warn("Raindrop logging failed (non-fatal):", e);
    }
  }
  return result;
}

// Call before process exit so buffered events are sent.
export async function closeTracing() {
  await raindrop?.close();
}
