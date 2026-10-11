# OwnerOrbit browser execution and confirmation agents

Deterministic Playwright skills for the OrderDesk mock. The executor changes an item,
re-reads persisted state and rendered UI on a fresh page, then checks simulated delivery
providers and pushes the menu once if stale. The harness owns identity, tenant resolution,
permissions and approval validation.

## Setup

```sh
npm ci
npx playwright install chromium
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

Keep MONGODB_URI empty for the in-memory demo, or supply the team's MongoDB URI.
`npm run dev` and `npm run try` load `.env`. HEADLESS=false opens a visible Chromium window.
The mock has no login; auth.json is unnecessary.

OrderDesk stores its menu in localStorage. Use the same PW_PROFILE for every live run.
Do not run two server/CLI processes against that profile simultaneously. Tests use a
local fixture and a temporary profile, leaving the live menu intact.

## Demo

```sh
npm run try -- middleware.mark_item_unavailable kids-chicken-nuggets-with-fries
npm run try -- middleware.mark_item_available kids-chicken-nuggets-with-fries
npm run try -- middleware.change_price kids-chicken-nuggets-with-fries 12.49
npm run try -- middleware.change_price kids-chicken-nuggets-with-fries 12.49 approved
npm run try -- middleware.push_provider_menus
```

The approved argument is a manual test approval. Production approval IDs must be validated
by the harness. Each CLI invocation generates a new key; replay a fixed key through
/execute to test request idempotency. An approved continuation after NEEDS_APPROVAL needs
a new key because completed results, including approval requests, are cached by key.

## HTTP contract

- GET /health: supported skill IDs.
- POST /execute: ExecuteRequest from src/skills/types.ts; returns ExecuteResult.
- POST /confirm: `{ itemId, expected?: { available?, price? }, autoPush?: boolean }`.

Only VERIFIED and ALREADY_DONE allow success responses to the owner. Inspect
confirmation.status too: inconsistent confirmations name the affected providers and
the message does not begin with “Done.” Screenshots are saved under evidence/.

DoorDash, Uber Eats and Grubhub are simulated. The mock exposes provider cards and one
menuSyncedAt timestamp, not actual provider menu snapshots. Standalone /confirm has no
pre-change baseline, so it conservatively returns INCONSISTENT without a new push.
Set autoPush:true to allow one push and a recheck. Read-only confirmation of previously
pushed snapshots requires the mock storefront upgrade described in the spec.

## Code map

| File | Responsibility |
| --- | --- |
| src/executor.ts | Key reservation, permissions, approvals, locking, retry, independent verification, results and audits |
| src/skills/menuSkills.ts | Fixed status, price and provider-push skills |
| src/skills/types.ts | Harness contract and request validation |
| src/tools/selectors.ts | OrderDesk URLs, status labels and active selectors |
| src/tools/middlewareBrowser.ts | Persistent browser, shared-profile queue, state reads/polling, screenshots |
| src/verification/readItem.ts | Persisted/UI snapshots and agreement check |
| src/confirmation/providers.ts | Mock adapters and unconfigured storefront template |
| src/confirmation/confirm.ts | Two-round check/push/recheck loop |
| src/server.ts | HTTP entrypoint |
| src/try.ts | Standalone CLI |
| src/trace.ts | Local spans and verification evaluation; Raindrop pending |
| test/agents.test.ts | Real-browser regression tests against a local fixture |

See [AGENT_REVIEW.md](AGENT_REVIEW.md) for the detailed review and remaining integration
work. The two spec files are identical.
