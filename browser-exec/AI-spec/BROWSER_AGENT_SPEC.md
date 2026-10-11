# Task: Finish the OwnerOrbit browser execution + confirmation agents

You are my coding agent at a hackathon. **Hard time limit: ~2 hours.** Ship one working, verified loop before anything else. Keep the code simple, and don't add frameworks or abstractions.

## Context

OwnerOrbit is an agent system for restaurant owners. An owner or manager texts a request over iMessage (through BlueBubbles), for example "Mark chicken nuggets out of stock." Teammates own everything upstream of my code:

- **Saddiq:** BlueBubbles/iMessage, the middleware site, the test restaurant data
- **Ash:** MongoDB data model, identity, tenant resolution, RBAC, approvals, and the agent harness. The harness turns the text into a structured intent and resolves "nuggets" to an item ID.

**I own everything after authorization.** It's two deterministic agents:

1. **Execution agent:** makes the change in the middleware (OrderDesk) and verifies it.
2. **Confirmation agent:** after a verified change, checks that DoorDash, Uber Eats and Grubhub are consistent with the middleware. If any is stale, it pushes the menu once and re-checks.

The core principle is that the LLM never decides whether an action succeeded. Both agents are fixed, versioned Playwright code, not free browsing. Success means re-reading the system and comparing what we wanted with what we see.

## The target site: OrderDesk

URL: https://orders-dashboard-eight-sepia.vercel.app/menu/overview (store: Falafel Flare Hayward, `storeId: "hayward"`)

**Critical facts (already verified by inspecting the site):**

- It is a **front-end-only mock** (Vite/React on Vercel). There is **no backend, no API calls and no login.**
- All data lives in the browser's **`localStorage["orderdesk:v1"]`**:
  `{ storeId, items[{ id, categoryId, name, price, status, stock, ... }], categories[{ id, name, links }], menuSyncedAt, accepting, ... }`
- Item `status` values (UI label in quotes): `available` ("Available"), `sold_out_today` ("Sold out today"), `sold_out` ("Sold out indefinitely"), `hidden` ("Hidden").
- Item IDs are slugs, e.g. `kids-chicken-nuggets-with-fries` (Chicken Nuggets with Fries, $11.99, Kids Meal).
- **Because state is per-browser, we must use ONE persistent Playwright profile** (`launchPersistentContext(".pw-profile")`). A fresh context reseeds the menu and our changes "disappear". The demo shows the Playwright window (`HEADLESS=false`).
- **DoorDash, Uber Eats and Grubhub are simulated.** `/providers` shows a card per provider labelled "Connected · menu synced". The "UPDATE PROVIDER MENUS" button only sets `menuSyncedAt = Date.now()` and toasts "Menu pushed to N providers". There are no real per-provider menus to read.

**UI map (selectors live ONLY in `src/tools/selectors.ts`):**

| What | How |
|---|---|
| Item row | name text (exact) → `xpath=ancestor::*[.//button[contains(@class,"status-btn")]][1]` (verified: resolves to exactly 1 status button) |
| Current status in UI | `button.status-btn` `title` attribute = status label |
| Change status | click `button.status-btn` → click `button.menu-item` with the label text |
| Price in row | first `$xx.xx` in row text |
| Edit price | click item name → editor panel → `.tf` containing `label.tf-label` "Price" → `input` → button "Update" (exact) |
| Push to providers | button "Update provider menus" |
| Provider status | `/providers` → `.provider-card` containing the provider name → text "Connected · menu synced" |

## Current code (in `browser-exec/`, type-checks clean). EXTEND it, don't rewrite it.

```
src/
  server.ts                     # GET /health, POST /execute, POST /confirm
  executor.ts                   # pipeline below; in-memory store if MONGODB_URI unset
  trace.ts                      # spans + eval; Raindrop TODO
  try.ts                        # CLI
  skills/types.ts               # Skill, ExecuteRequest, ExecuteResult
  skills/menuSkills.ts          # mark_item_unavailable / _sold_out / _available, change_price, push_provider_menus
  tools/selectors.ts            # all OrderDesk selectors/URLs/status map
  tools/middlewareBrowser.ts    # persistent context, gotoMenu, readState (localStorage), waitForState, screenshot
  verification/readItem.ts      # reload, then read persisted state AND rendered UI; uiAgrees()
  confirmation/providers.ts     # ProviderAdapter interface; MockSyncAdapter; StorefrontAdapter template
  confirmation/confirm.ts       # confirmation loop
```

## Contract with the harness (do not change without telling Ash)

```ts
interface ExecuteRequest {
  runId: string;
  idempotencyKey: string;          // same key => same result, never re-executed
  tenantId: string;
  actor: { userId: string; role: "OWNER"|"GM"|"MANAGER"|"EMPLOYEE"; permissions: string[] };
  skillId: string;
  inputs: Record<string, unknown>; // e.g. { itemId: "kids-chicken-nuggets-with-fries" }
  approvalId?: string;             // required for change_price
}
interface ExecuteResult {
  status: "VERIFIED" | "ALREADY_DONE" | "FAILED" | "NEEDS_HUMAN" | "NEEDS_APPROVAL";
  message: string;                 // ready to text back to the owner
  before?: unknown; after?: unknown;
  evidence: string[];              // screenshot paths
  attempts: number;
  confirmation?: { status: "CONSISTENT" | "INCONSISTENT"; pushed: boolean;
                   checks: { provider: string; ok: boolean; observed: {available:boolean;price:number}|null; note: string }[];
                   evidence: string[] };
}
```

Only `VERIFIED` and `ALREADY_DONE` may lead to "Done." being sent to the owner. If `confirmation.status === "INCONSISTENT"`, the message must name the providers that are out of sync.

## Skills

| skillId | permission | approval | inputs | done when |
|---|---|---|---|---|
| `middleware.mark_item_unavailable` | `menu.write` | no | `{ itemId }` | status `sold_out_today` in state AND UI |
| `middleware.mark_item_sold_out` | `menu.write` | no | `{ itemId }` | status `sold_out` |
| `middleware.mark_item_available` | `menu.write` | no | `{ itemId }` | status `available` (also the rollback) |
| `middleware.change_price` | `pricing.write` | **always** | `{ itemId, newPrice }` | price matches to the cent in state AND UI |
| `middleware.push_provider_menus` | `menu.write` | no | `{}` | `menuSyncedAt` increased |
| *(stretch)* `middleware.list_menu_items` | `menu.read` | no | `{}` | returns `[{ id, name, price, status, category }]` from state, for Ash's entity resolution |

Each skill has `expected(input)` → `{ available?, price? }`. This is what providers should show, and it feeds the confirmation agent.

## Execution pipeline (`executor.ts`, already implemented; keep this behavior)

1. **Idempotency:** a stored result for `idempotencyKey` is returned as-is. Duplicate in-flight → FAILED "already in progress".
2. Unknown skill, missing permission, or invalid inputs (zod) → FAILED before the browser opens.
3. Record the RUNNING run and audit `execution.started`. Take the per-tenant lock.
4. **Read before acting.** If already done → ALREADY_DONE.
5. **Approval gate:** no `approvalId` when one is required → NEEDS_APPROVAL, with nothing executed.
6. **Execute** (max 2 attempts). Wait on `waitForState` (the app persisted the change), never on a sleep.
7. **Verify on a NEW page after a reload.** The persisted state must match the target AND the rendered UI must agree with the state (`uiAgrees`).
8. If verified → run the **confirmation agent** → final message → write `action_runs` and `audit_log`.
9. Retries run out → NEEDS_HUMAN. `NeedsHuman` errors (e.g. item not found) → NEEDS_HUMAN with a screenshot.

## Confirmation agent (`confirmation/`)

- `ProviderAdapter.read(page, item)` → `{ view: { available, price } | null, note }`. One adapter per provider (DoorDash, Uber Eats, Grubhub).
- **`MockSyncAdapter` (current):** fits the mock. A provider shows the master values only if its card says "Connected · menu synced" AND `menuSyncedAt >= changedAt`. Otherwise it's stale and shows the `before` values.
- **Loop:** check all providers. If they're all consistent → CONSISTENT. If not, push once with `push_provider_menus`, re-check, and return CONSISTENT or INCONSISTENT with per-provider details. Screenshot each round.
- **`StorefrontAdapter` (template):** for real or mock storefront pages. Fill in the URL and selectors, then swap it into `PROVIDERS`. The loop itself stays the same.
- `POST /confirm { itemId, expected?, autoPush? }` runs the check on its own.

### Upgrade path (only if Saddiq agrees and there's time)

If Saddiq controls the OrderDesk repo, add same-origin routes `/mock/doordash`, `/mock/ubereats` and `/mock/grubhub`. Each renders the menu snapshot saved at the last "Update provider menus" click, so it shares the same localStorage. Then use `StorefrontAdapter` for each. The demo becomes: change in OrderDesk → DoorDash still shows the old value (INCONSISTENT) → the agent pushes → all three match (CONSISTENT). Don't attempt real doordash.com, ubereats.com or grubhub.com pages in 2 hours: bot protection, and they can't see our mock data.

## Env

```
MIDDLEWARE_URL=https://orders-dashboard-eight-sepia.vercel.app
MONGODB_URI=            # optional; in-memory store if empty
HEADLESS=false
PW_PROFILE=.pw-profile
PORT=4001
```

`.gitignore`: `node_modules`, `evidence`, `.env`, `.pw-profile`.

## Commands

```
npm install && npx playwright install chromium
npx tsx --env-file=.env src/try.ts middleware.mark_item_unavailable kids-chicken-nuggets-with-fries
npx tsx --env-file=.env src/try.ts middleware.mark_item_available  kids-chicken-nuggets-with-fries
npx tsx --env-file=.env src/try.ts middleware.change_price kids-chicken-nuggets-with-fries 12.49            # NEEDS_APPROVAL
npx tsx --env-file=.env src/try.ts middleware.change_price kids-chicken-nuggets-with-fries 12.49 approved   # VERIFIED
npm run dev   # POST /execute, POST /confirm
```

## Order of work

1. Install, `npx tsc` clean, `/health` lists the skills.
2. Run `mark_item_unavailable` on the nuggets with `HEADLESS=false`. Watch it work and fix any selector that fails. **This is the demo. Stop and tell me when it returns VERIFIED with confirmation CONSISTENT (pushed: true).**
3. `mark_item_available`, then `change_price` (both the approval and no-approval paths).
4. Idempotency check: the same key twice → identical result and no second browser run.
5. Raindrop: replace the TODO in `trace.ts`.
6. *(Stretch)* `list_menu_items`, then the mock storefront upgrade.

## Acceptance criteria

- [ ] `npx tsc` passes with `strict: true`.
- [ ] Nuggets → `VERIFIED`. The screenshot shows "Sold out today", `confirmation.status = CONSISTENT`, `pushed = true` (the first run is stale, so it pushes).
- [ ] Running again → `ALREADY_DONE`, with no clicks.
- [ ] `change_price` without `approvalId` → `NEEDS_APPROVAL`, and the price is unchanged in state.
- [ ] An actor without the permission → `FAILED`, and the browser never opens.
- [ ] A bad `itemId` → `NEEDS_HUMAN`, never `VERIFIED`.
- [ ] Breaking a selector on purpose → `NEEDS_HUMAN` with an error screenshot.
- [ ] Every run leaves an `action_runs` record and audit events (Mongo, or the in-memory log).

## Do NOT

- Let an LLM choose clicks or judge success.
- Use a fresh browser context per run, because it loses the menu state.
- Call "Reset demo" or clear localStorage, except deliberately before a demo.
- Scrape real DoorDash, Uber Eats or Grubhub sites.
- Build a UI or dashboard, or add services.
- Change the `ExecuteRequest`/`ExecuteResult` contract silently.
- Edit the team's Google Doc.

When you're blocked on something only I can provide, stop and ask one precise question. Don't invent values.
