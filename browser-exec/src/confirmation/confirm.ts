// Confirmation agent: runs AFTER the middleware change is VERIFIED.
// Checks every delivery provider shows the same thing as the middleware. If any is stale,
// it pushes the menu once ("Update Provider Menus") and re-checks. Deterministic, no LLM.
import type { Page } from "playwright";
import { PROVIDERS, type ItemContext, type ProviderView } from "./providers.js";
import { pushProviderMenus } from "../skills/menuSkills.js";
import { screenshot } from "../tools/middlewareBrowser.js";

export interface ProviderCheck {
  provider: string; ok: boolean; observed: ProviderView | null; note: string;
}
export interface ConfirmationResult {
  status: "CONSISTENT" | "INCONSISTENT";
  pushed: boolean;
  checks: ProviderCheck[];
  evidence: string[];
}

const matches = (obs: ProviderView | null, exp: { available?: boolean; price?: number }) =>
  !!obs &&
  (exp.available === undefined || obs.available === exp.available) &&
  (exp.price === undefined || Math.abs(obs.price - exp.price) < 0.005);

export async function confirmAcrossProviders(
  page: Page,
  item: ItemContext,
  expected: { available?: boolean; price?: number },
  opts: { autoPush: boolean; span?: <T>(n: string, f: () => Promise<T>) => Promise<T> } = { autoPush: true },
): Promise<ConfirmationResult> {
  const span = opts.span ?? (<T,>(_n: string, f: () => Promise<T>) => f());
  const evidence: string[] = [];
  let pushed = false;

  for (let round = 1; round <= 2; round++) {
    const checks: ProviderCheck[] = [];
    for (const p of PROVIDERS) {
      try {
        const { view, note } = await span(`confirm_${p.id}_${round}`, () => p.read(page, item));
        checks.push({ provider: p.name, ok: matches(view, expected), observed: view, note });
      } catch (e) {
        checks.push({ provider: p.name, ok: false, observed: null, note: `Could not read provider: ${String(e)}` });
      }
    }
    evidence.push(await screenshot(page, `providers-round${round}`));

    if (checks.every((c) => c.ok)) return { status: "CONSISTENT", pushed, checks, evidence };
    if (round === 2 || !opts.autoPush) return { status: "INCONSISTENT", pushed, checks, evidence };

    // Self-heal once: push the menu to providers, then re-check.
    try {
      await span("confirm_push", () => pushProviderMenus.execute(page, {}));
      pushed = true;
    } catch (e) {
      for (const check of checks.filter((c) => !c.ok)) check.note += `; push failed: ${String(e)}`;
      evidence.push(await screenshot(page, "providers-push-error"));
      return { status: "INCONSISTENT", pushed, checks, evidence };
    }
  }
  throw new Error("unreachable");
}
