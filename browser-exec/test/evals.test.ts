import { test } from "node:test";
import assert from "node:assert/strict";
import { runEvals } from "../src/trace.js";

const span = (name: string, ok = true) => ({ name, ms: 10, ok });
const get = (evals: ReturnType<typeof runEvals>, n: string) => evals.find((e) => e.name === n)!;

test("verified + consistent run passes every eval", () => {
  const e = runEvals(
    { status: "VERIFIED", message: "Done", evidence: [], attempts: 1,
      confirmation: { status: "CONSISTENT", pushed: true, checks: [{ provider: "DoorDash", ok: true, observed: null, note: "" }], evidence: [] } } as any,
    [span("read_before"), span("execute_1"), span("verify_1")], 4000);
  assert.ok(e.every((x) => x.pass), JSON.stringify(e));
  assert.equal(e.length, 5);
});

test("claiming VERIFIED without a passing verify span fails honest_claim", () => {
  const e = runEvals({ status: "VERIFIED", message: "Done", evidence: [], attempts: 1 } as any,
    [span("read_before"), span("execute_1"), span("verify_1", false)], 4000);
  assert.equal(get(e, "honest_claim").pass, false);
});

test("broken skill → NEEDS_HUMAN is honest but not completed", () => {
  const e = runEvals({ status: "NEEDS_HUMAN", message: "x", evidence: [], attempts: 2 } as any,
    [span("read_before"), span("execute_1", false), span("verify_1", false), span("execute_2", false), span("verify_2", false)], 20000);
  assert.equal(get(e, "honest_claim").pass, true);
  assert.equal(get(e, "task_completed").pass, false);
  assert.equal(get(e, "first_try").pass, false);
  assert.equal(get(e, "fast_enough").pass, false);
});

test("inconsistent providers fail providers_consistent", () => {
  const e = runEvals(
    { status: "VERIFIED", message: "x", evidence: [], attempts: 1,
      confirmation: { status: "INCONSISTENT", pushed: true, checks: [{ provider: "Grubhub", ok: false, observed: null, note: "" }], evidence: [] } } as any,
    [span("read_before"), span("verify_1")], 3000);
  assert.equal(get(e, "providers_consistent").pass, false);
  assert.match(get(e, "providers_consistent").detail, /Grubhub/);
});
