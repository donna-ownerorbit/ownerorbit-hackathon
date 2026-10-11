// Provider adapters for the confirmation agent.
// Each adapter answers ONE question: "what does <provider> currently show for this item?"
//
// Reality check on the current OrderDesk mock: DoorDash / Uber Eats / Grubhub are NOT real
// integrations. The app only has (a) a "Connected · menu synced" label per provider on /providers
// and (b) a menuSyncedAt timestamp set by "Update Provider Menus". So MockSyncAdapter infers what
// each provider shows: the master menu as of the last push. If the push happened before the
// change, the provider is stale and still shows the "before" value.
//
// When real or mock storefront pages exist (e.g. /mock/doordash routes added to the same app,
// or real store URLs), implement StorefrontAdapter below and swap it into PROVIDERS. Nothing
// else in the confirmation loop changes.
import type { Page } from "playwright";
import { readState } from "../tools/middlewareBrowser.js";
import { URLS, sel } from "../tools/selectors.js";

export interface ProviderView { available: boolean; price: number }

export interface ItemContext {
  itemId: string;
  name: string;
  before: ProviderView | null; // null when no pre-change baseline was observed
  current: ProviderView;     // verified master value after our change
  changedAt: number;         // ms timestamp of our change
}

export interface ProviderAdapter {
  id: "doordash" | "ubereats" | "grubhub" | "website";
  name: string;
  read(page: Page, item: ItemContext): Promise<{ view: ProviderView | null; note: string }>;
}

class MockSyncAdapter implements ProviderAdapter {
  constructor(public id: ProviderAdapter["id"], public name: string) {}
  async read(page: Page, item: ItemContext) {
    await page.goto(URLS.providers, { waitUntil: "domcontentloaded" });
    const card = sel.providerCard(page, this.name);
    await card.first().waitFor({ timeout: 10_000 });
    const text = await card.first().innerText();
    if (!/Connected · menu synced/.test(text)) return { view: null, note: "provider paused/disconnected" };
    const { menuSyncedAt } = await readState(page);
    return menuSyncedAt >= item.changedAt
      ? { view: item.current, note: `synced ${new Date(menuSyncedAt).toISOString()}` }
      : { view: item.before, note: "menu not pushed since change/check (stale; simulated provider values)" };
  }
}

// Template for when a real/mock storefront page exists. Fill URL + selectors, then use it.
export class StorefrontAdapter implements ProviderAdapter {
  constructor(public id: ProviderAdapter["id"], public name: string, private storeUrl: string) {}
  async read(page: Page, item: ItemContext) {
    await page.goto(this.storeUrl, { waitUntil: "domcontentloaded" });
    const card = page.getByText(item.name, { exact: true }).first()
      .locator("xpath=ancestor::*[contains(., '$')][1]"); // TODO: tighten to the storefront's item card
    if (!(await card.count())) return { view: { available: false, price: NaN }, note: "item not listed" };
    const text = await card.innerText();
    const price = Number(text.match(/\$(\d+(\.\d{2})?)/)?.[1] ?? NaN);
    const available = !/sold out|unavailable/i.test(text); // TODO: match the storefront's wording
    return { view: { available, price }, note: "read from storefront" };
  }
}

export const PROVIDERS: ProviderAdapter[] = [
  new MockSyncAdapter("doordash", "DoorDash"),
  new MockSyncAdapter("ubereats", "Uber Eats"),
  new MockSyncAdapter("grubhub", "Grubhub"),
];
