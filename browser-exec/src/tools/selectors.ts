// ALL OrderDesk (middleware) UI knowledge lives here.
// Mapped from https://orders-dashboard-eight-sepia.vercel.app (front-end-only mock;
// state persists in localStorage key "orderdesk:v1" — there is no backend/API).
import type { Page, Locator } from "playwright";

export const BASE = (process.env.MIDDLEWARE_URL ?? "https://orders-dashboard-eight-sepia.vercel.app").replace(/\/$/, "");
export const URLS = {
  menu: `${BASE}/menu/overview`,
  providers: `${BASE}/providers`,
};
export const STATE_KEY = "orderdesk:v1";

// App's status enum (from the bundle): label shown in UI <-> stored value
export const STATUS = {
  available: "Available",
  sold_out_today: "Sold out today",
  sold_out: "Sold out indefinitely",
  hidden: "Hidden",
} as const;
export type ItemStatus = keyof typeof STATUS;

export const sel = {
  menuReady: (p: Page) => p.locator("button.status-btn").first(),
  providerCard: (p: Page, name: string) => p.locator(".provider-card", { hasText: name }).first(),
  // Item name text in the menu list (exact match). The editor panel uses <input>, so no clash.
  itemName: (p: Page, name: string) => p.getByText(name, { exact: true }),
  // Nearest ancestor of the name that contains a status button = the item row
  itemRow: (p: Page, name: string): Locator =>
    sel.itemName(p, name).locator('xpath=ancestor::*[.//button[contains(@class,"status-btn")]][1]'),
  // Status dropdown button in the row; its title attribute is the current status label
  statusBtn: (row: Locator) => row.locator("button.status-btn"),
  // DEMO: SIMULATE_UI_CHANGE=true pretends OrderDesk renamed its status options, so the status
  // skills fail honestly (NEEDS_HUMAN) and Raindrop flags it. Unset it + bump skill version = "fix".
  statusOption: (p: Page, label: string) =>
    p.locator("button.menu-item", { hasText: process.env.SIMULATE_UI_CHANGE === "true" ? `${label} (renamed)` : label }),

  // Item editor (opens when the item name is clicked)
  priceInput: (p: Page) =>
    p.locator(".tf", { has: p.locator("label.tf-label", { hasText: /^Price$/ }) }).first().locator("input"),
  updateBtn: (p: Page) => p.getByRole("button", { name: "Update", exact: true }),
  cancelBtn: (p: Page) => p.getByRole("button", { name: "Cancel", exact: true }),

  // Push to DoorDash / Uber Eats / Grubhub / Website
  pushProvidersBtn: (p: Page) => p.getByRole("button", { name: /update provider menus/i }),
};
