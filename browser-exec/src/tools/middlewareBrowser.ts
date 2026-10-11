import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import { STATE_KEY, URLS, sel } from "./selectors.js";

let ctx: BrowserContext | null = null;
let opening: Promise<BrowserContext> | null = null;

// NOTE: OrderDesk now persists to its own backend (/api/state); localStorage is only its offline
// fallback. We still use one persistent
// browser profile. A fresh context = fresh seed menu = changes "disappear".
// The demo shows THIS browser window (HEADLESS=false); other people's browsers have their own copy.
export async function getContext(): Promise<BrowserContext> {
  if (ctx) return ctx;
  if (opening) return opening;
  opening = chromium.launchPersistentContext(process.env.PW_PROFILE ?? ".pw-profile", {
    headless: process.env.HEADLESS === "true",
    viewport: { width: 1440, height: 900 },
  });
  try {
    ctx = await opening;
    ctx.on("close", () => { ctx = null; });
    return ctx;
  } finally {
    opening = null;
  }
}

// All tenants currently share one mock store/profile, including /confirm pushes.
// Serialize access to that resource, not just to the logical tenant.
let browserQueue: Promise<unknown> = Promise.resolve();
export function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = browserQueue.then(fn, fn);
  browserQueue = next.catch(() => {});
  return next;
}

export async function newPage(): Promise<Page> {
  return (await getContext()).newPage();
}

export async function gotoMenu(page: Page) {
  await page.goto(URLS.menu, { waitUntil: "domcontentloaded" });
  await sel.menuReady(page).waitFor({ timeout: 15_000 });
}

export interface MenuItem {
  id: string; name: string; categoryId: string; price: number; status: string; stock: number;
}
export interface AppState {
  storeId: string; items: MenuItem[]; categories: { id: string; name: string; links: number }[];
  menuSyncedAt: number; accepting: boolean;
}

// Structured read of OrderDesk's persisted state.
// OrderDesk now has a backend: GET /api/state returns the menu from its MongoDB ("db" mode), and the
// UI saves through PATCH /api/items/:id and /api/restaurant. That backend is the source of truth.
// If the API is unreachable, the app falls back to localStorage ("local" mode) — so do we.
export async function readState(page: Page): Promise<AppState> {
  const res = await page.evaluate(async (k) => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (r.ok) {
        const st = await r.json();
        if (st && Array.isArray(st.items)) {
          return {
            source: "db",
            state: {
              storeId: st.restaurant?.storeId,
              accepting: st.restaurant?.accepting ?? true,
              menuSyncedAt: st.restaurant?.menuSyncedAt ?? 0,
              items: st.items,
              categories: st.categories ?? [],
            },
          };
        }
      }
    } catch { /* fall through to local mode */ }
    const raw = localStorage.getItem(k);
    return { source: "local", state: raw ? JSON.parse(raw) : null };
  }, STATE_KEY);
  if (!res.state) throw new Error("OrderDesk state not found (API and localStorage both empty)");
  return res.state as AppState;
}

export async function findItem(page: Page, itemId: string): Promise<MenuItem> {
  const item = (await readState(page)).items.find((i) => i.id === itemId);
  if (!item) throw new NeedsHuman(`Item ${itemId} not found in menu`);
  return item;
}

// Poll until the app has persisted the expected change (backend, or localStorage in local mode).
export async function waitForState(page: Page, pred: (s: AppState) => boolean, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(await readState(page))) return;
    await page.waitForTimeout(200);
  }
  throw new Error("Change was not persisted by the app in time");
}

export async function screenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync("evidence", { recursive: true });
  const path = `evidence/${Date.now()}-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}

export class NeedsHuman extends Error {}

export async function closeBrowser() {
  if (opening) await opening.catch(() => {});
  await ctx?.close();
  ctx = null;
}
