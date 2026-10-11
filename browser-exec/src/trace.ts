// Minimal tracer. Swap the bodies for the Raindrop SDK calls once someone has the key/docs —
// the executor already calls span() around read / execute / verify.
type SpanFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export async function trace<T>(runId: string, skillId: string, fn: (span: SpanFn) => Promise<T>): Promise<T> {
  const spans: { name: string; ms: number; ok: boolean }[] = [];
  const span: SpanFn = async (name, f) => {
    const t = Date.now();
    try {
      const r = await f();
      spans.push({ name, ms: Date.now() - t, ok: true });
      return r;
    } catch (e) {
      spans.push({ name, ms: Date.now() - t, ok: false });
      throw e;
    }
  };
  const result = await fn(span);
  // Eval: did the system claim success only when verification passed?
  const status = (result as any)?.status;
  console.log(JSON.stringify({ trace: runId, skillId, status, spans, eval_claim_matches_verification: status !== "VERIFIED" || spans.some((s) => s.name.startsWith("verify") && s.ok) }));
  // TODO: raindrop.track({ event: "skill_execution", properties: { runId, skillId, status, spans } })
  return result;
}
