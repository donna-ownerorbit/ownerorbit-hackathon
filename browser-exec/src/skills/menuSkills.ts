import { z } from "zod";
import type { Skill } from "./types.js";
import { gotoMenu, findItem, waitForState, readState } from "../tools/middlewareBrowser.js";
import { sel, STATUS, URLS, type ItemStatus } from "../tools/selectors.js";
import { readItem, uiAgrees, type ItemSnapshot } from "../verification/readItem.js";

async function setStatus(page: import("playwright").Page, itemId: string, target: ItemStatus) {
  await gotoMenu(page);
  const item = await findItem(page, itemId);
  const row = sel.itemRow(page, item.name);
  await row.scrollIntoViewIfNeeded();
  await sel.statusBtn(row).click();
  await sel.statusOption(page, STATUS[target]).click();
  await waitForState(page, (s) => s.items.find((i) => i.id === itemId)?.status === target);
}

const statusSkill = (id: string, target: ItemStatus): Skill<{ itemId: string }, ItemSnapshot> => ({
  id, version: 1,
  requiredPermission: "menu.write",
  requiresApproval: () => false,
  inputs: z.object({ itemId: z.string().trim().min(1) }),
  read: (page, i) => readItem(page, i.itemId),
  isDone: (s) => s.status === target && uiAgrees(s),
  execute: (page, i) => setStatus(page, i.itemId, target),
  expected: () => ({ available: target === "available" }),
});

// "Out of stock" from a manager = sold out today (resets tomorrow). Indefinite is a separate skill.
export const markItemUnavailable = statusSkill("middleware.mark_item_unavailable", "sold_out_today");
export const markItemSoldOutIndefinitely = statusSkill("middleware.mark_item_sold_out", "sold_out");
export const markItemAvailable = statusSkill("middleware.mark_item_available", "available");

export const changePrice: Skill<{ itemId: string; newPrice: number }, ItemSnapshot> = {
  id: "middleware.change_price", version: 1,
  requiredPermission: "pricing.write",
  requiresApproval: () => true, // doc: price change → explicit owner approval
  inputs: z.object({ itemId: z.string().trim().min(1), newPrice: z.number().finite().positive().max(500)
    .refine((p) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-8, "Price must have at most two decimal places") }),
  read: (page, i) => readItem(page, i.itemId),
  isDone: (s, i) => Math.abs(s.price - i.newPrice) < 0.005 && uiAgrees(s),
  execute: async (page, i) => {
    await gotoMenu(page);
    const item = await findItem(page, i.itemId);
    await sel.itemName(page, item.name).click();          // opens editor panel
    const input = sel.priceInput(page);
    await input.waitFor();
    await input.fill(i.newPrice.toFixed(2));
    await sel.updateBtn(page).click();
    await waitForState(page, (s) => Math.abs((s.items.find((x) => x.id === i.itemId)?.price ?? -1) - i.newPrice) < 0.005);
  },
  expected: (i) => ({ price: i.newPrice }),
};

// Pushes the menu to DoorDash / Uber Eats / Grubhub / Website (sets menuSyncedAt in the mock).
export const pushProviderMenus: Skill<{}, { menuSyncedAt: number }> = {
  id: "middleware.push_provider_menus", version: 1,
  requiredPermission: "menu.write",
  requiresApproval: () => false,
  inputs: z.object({}),
  read: async (page) => { await gotoMenu(page); return { menuSyncedAt: (await readState(page)).menuSyncedAt }; },
  isDone: (state, _input, before) => !!before && state.menuSyncedAt > before.menuSyncedAt,
  execute: async (page) => {
    await gotoMenu(page);
    const before = (await readState(page)).menuSyncedAt;
    await sel.pushProvidersBtn(page).click();
    await waitForState(page, (s) => s.menuSyncedAt > before, 10_000);
  },
};

export const registry: Record<string, Skill> = Object.fromEntries(
  [markItemUnavailable, markItemSoldOutIndefinitely, markItemAvailable, changePrice, pushProviderMenus].map((s) => [s.id, s]),
);
export { URLS };
