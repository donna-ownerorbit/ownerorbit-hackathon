import type { Page } from "playwright";
import { findItem, gotoMenu } from "../tools/middlewareBrowser.js";
import { sel, STATUS, type ItemStatus } from "../tools/selectors.js";

export interface ItemSnapshot {
  itemId: string; name: string;
  status: ItemStatus;        // from persisted state
  uiStatusLabel: string;     // from the rendered UI (status button title)
  price: number;             // from persisted state
  uiPriceText: string;       // from the rendered row
}

// Always does a full reload, then reads BOTH the app's persisted state and the rendered UI.
// Verification passes only if the two agree — two independent observations.
export async function readItem(page: Page, itemId: string): Promise<ItemSnapshot> {
  await gotoMenu(page);
  // React can initially render seed values before restoring the persistent menu.
  // Poll agreement, not elapsed time, so startup cannot trigger an unnecessary write.
  const deadline = Date.now() + 2000;
  while (true) {
    const item = await findItem(page, itemId);
    const row = sel.itemRow(page, item.name);
    await row.scrollIntoViewIfNeeded();
    const uiStatusLabel = (await sel.statusBtn(row).getAttribute("title")) ?? "";
    const uiPriceText = (await row.innerText()).match(/\$\d+(\.\d{2})?/)?.[0] ?? "";
    const snapshot = { itemId, name: item.name, status: item.status as ItemStatus, uiStatusLabel, price: item.price, uiPriceText };
    if (uiAgrees(snapshot) || Date.now() >= deadline) return snapshot;
    await page.waitForTimeout(100);
  }
}

export function uiAgrees(s: ItemSnapshot): boolean {
  return s.uiStatusLabel === STATUS[s.status] && s.uiPriceText === `$${s.price.toFixed(2)}`;
}
