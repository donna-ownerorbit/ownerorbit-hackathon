# Browser agent review — October 11, 2026

Working location: `ownerorbit-hackathon/browser-exec` on `abdullah's-branch`.
The original Downloads workspace was moved into this repository with its local runtime
files preserved and ignored by Git.

## Scope and architecture

Read every application source file, README, package manifest, TypeScript configuration,
environment example, ignore file, both agent specs and dependency lock metadata. The root
BROWSER_AGENT_SPEC.md and AI-spec/BROWSER_AGENT_SPEC.md are byte-identical. There are no
repository-specific AGENTS.md instructions in this directory or its parents.

This is the post-authorization execution layer. Upstream code interprets owner messages,
resolves item IDs and tenants, authenticates actors and validates permissions/approvals.
This package's two agents are fixed TypeScript/Playwright workflows.

Execution reserves a request key, validates permissions and inputs, queues browser
access, reads before acting, checks natural idempotency, gates price changes, performs
a UI mutation and verifies on a fresh page. Confirmation reads each provider, pushes
once if needed and rereads all providers. Final results include audits and screenshots.
All menu mutations use UI clicks/inputs. localStorage is used for observation and
persistence verification. The live demo profile was not reset or cleared.

## File-level findings and completed fixes

### src/executor.ts

The independent verification page is the strongest part of the original design. Several
failure/concurrency paths around it were incomplete:

- Validation failures upserted a result before reserving a key. A duplicate with different
  permissions or inputs could overwrite an in-flight run.
- Mongo initialization was not shared and exposed collections before the unique index
  was ready. Any insert exception was described as a duplicate, including other DB errors.
- Browser startup was outside the protected block. A missing Chromium executable escaped
  execution and left the run RUNNING. This happened during initial setup.
- Failed verification reads bypassed retries and leaked verification pages.
- Verification spans passed when reading succeeded, even if the success predicate failed.
- Per-tenant locks allowed concurrent access to the same single mock profile/store.
- Confirmation compared only the changed field instead of both availability and price.

These are corrected. Reservation precedes validation results; duplicate-key errors are
distinguished from other database failures. Mongo initialization is shared and creates
the index before exposing collections. Browser startup is protected; verification runs
its predicate inside the span, retries failed reads and closes pages in finally blocks.
The tenant queue remains, with a shared-profile queue around browser work; completed
tenant locks are removed. Final audits include attempts and confirmation details.
Registry lookup uses own properties, rejecting inherited names such as __proto__.

Malformed request envelopes return FAILED before DB/browser access. Well-formed requests
reserve a key and leave a final result/audit even when skill, permission or input
validation fails. Public request/result fields and status vocabulary remain unchanged.
Opaque run/tenant/idempotency identifiers retain their original values during validation.

### src/skills/menuSkills.ts and src/skills/types.ts

Status skills distinguish sold-out-today from indefinite sold-out status and require
menu.write. Price changes require pricing.write and an approval reference, edit through
the UI and wait for persistence. Empty item IDs and fractional-cent price targets now
fail validation before browser access.

The provider-push skill originally always returned false from isDone, so successful
pushes ended in NEEDS_HUMAN. The internal predicate now receives an optional before
snapshot and checks that menuSyncedAt increased. This is an internal Skill change, not
an ExecuteRequest/ExecuteResult contract change.

Already-done checks still precede approval checks, as specified, and do not mutate.
Approval IDs are upstream-validated references. An approved continuation requires a new
key after a cached NEEDS_APPROVAL result.

### src/tools/middlewareBrowser.ts and src/tools/selectors.ts

Persistent Chromium is essential: unrelated browser profiles have separate menus.
Concurrent startup now shares one launch promise. Execute and confirm operations queue
access to the shared profile. This lock is process-local; independent processes still
must not use the same profile simultaneously.

Reads parse orderdesk:v1, unknown item IDs raise NeedsHuman, persistence waits poll a
predicate and screenshots go to evidence/. Active menu-ready/provider-card selectors
were moved into selectors.ts. MIDDLEWARE_URL tolerates a trailing slash. Exact item-name
lookup no longer silently picks the first match, allowing ambiguous matches to fail
before a mutation. The localStorage structure is still trusted at runtime; an upstream
mock schema change would require updating the reader.

### src/verification/readItem.ts

Reads navigate to the menu again, resolve the item from state, inspect the status button
title and extract the first currency amount from the item row. uiAgrees compares the
title against the stored enum label and the price against its two-decimal rendering.
Execution also compares the requested target. This fits the current mock; a UI change
adding another currency amount would require a dedicated price selector. Screenshots
show the status indicator; the readable status label is captured from its title in the
returned snapshot.

A later live HTTP check exposed a brief startup interval where localStorage had the
persisted sold-out status but React still rendered the seed Available status. Verification
caught it, but execution unnecessarily retried. readItem now polls persisted/UI agreement
for up to two seconds before returning a snapshot. Persistent disagreement still fails
the success predicate; no fixed delay is required when the two observations already agree.

### src/confirmation/providers.ts and src/confirmation/confirm.ts

Adapters inspect provider cards and a single shared menuSyncedAt. They infer before/current
provider values using the sync timestamp. They do not read real delivery storefront menus.

Provider read failures now become failed checks with provider names. Push failures return
INCONSISTENT with notes and an error screenshot. The loop still pushes at most once.
Middleware success with inconsistent providers retains VERIFIED, while the owner message
names affected providers and avoids “Done.” Both availability and price are compared.

StorefrontAdapter remains an unused template. Its generic ancestor locator and text
heuristics must be replaced before registering it. Same-origin mock snapshot pages would
allow independent provider observations and are the strongest next upgrade.

### src/server.ts, src/try.ts, src/trace.ts and configuration

The Express app is now exported for integration tests and only listens when started as
the entrypoint. Standalone confirmation validates before browser access, protects startup
and participates in the shared profile queue.

Previously /confirm used changedAt=0 and copied current master values into both snapshots,
allowing a connected card to imply fresh consistency without a recent push. It now uses
an unknown baseline and requires a push after the check starts to establish simulated
freshness. Read-only standalone checks conservatively return INCONSISTENT. This behavior
change is documented in README; request/result shapes remain unchanged.

The CLI generates unique keys, provides a test owner and closes the browser. Its approved
argument is a manual test placeholder. Trace output remains local; a successful verify
span now includes a passed predicate. Raindrop remains pending because no configuration
or key is supplied here.

README now describes the actual mock rather than login/auth.json/network waits. The Mongo
placeholder was removed from .env.example so copying it starts the in-memory demo.
npm dev/try load .env explicitly. Strict typechecking includes tests. npm ci installed
the existing lockfile; dependency versions were not upgraded.

## Verification

The initial live HEADLESS=false demo changed Chicken Nuggets with Fries from available
to sold_out_today at $11.99. It returned VERIFIED on attempt one with confirmation
CONSISTENT and pushed:true. Available rollback also passed. Unapproved $12.49 returned
NEEDS_APPROVAL with zero attempts and a $11.99 before snapshot. Approved $12.49 returned
VERIFIED/CONSISTENT with one push. Price was then restored to $11.99 using the approved UI.

Initial demo evidence:

- evidence/1791757056834-verify-1.png — independent item verification.
- evidence/1791757057761-providers-round1.png — before the corrective push.
- evidence/1791757060139-providers-round2.png — after the push.

Tests run real Chromium against a local HTTP fixture implementing the mock UI/state
contract, using a disposable profile. They cover permission rejection before startup,
malformed/unknown/invalid inputs, concurrent context initialization, execution and
confirmation, already-done/no-click behavior, exact key replay, approval/unchanged price,
explicit pushes, in-flight duplicate protection, missing items, UI disagreement, transient
verification-read retry, page cleanup, disconnected providers, health, conservative
standalone confirmation, broken selectors, provider read/push errors and launch failure
with terminal-result replay. Strict TypeScript checking passes.

Mongo-backed runs have not been exercised; live and automated checks use the memory store.
Raindrop and storefront adapters have not been exercised.

Live HTTP /health listed all five skills. Replaying a fixed key returned identical cached
results. A subsequent fresh-key repeat returned ALREADY_DONE with zero attempts. Evidence
is saved in evidence/live-idempotency.json and evidence/live-already.json. The final live
demo item is sold_out_today at its original $11.99 price. A local .env was created from the
example with Mongo disabled; no external credentials were added.

## Remaining integration work

1. Connect Ash's harness and Mongo configuration. Confirm approval continuation keys,
   collection/database names and owner messages for inconsistent confirmations.
2. Agree with Saddiq on mock storefront snapshot routes and replace inference adapters.
3. Add Raindrop with the team's SDK/configuration/key, preserving predicate-based evidence.
4. Add list_menu_items if entity resolution needs it, with clear read-only success behavior.

The service currently targets one Hayward mock store. tenantId contributes to queuing and
audits; it does not select or validate separate restaurant data. Production isolation
needs store/profile mapping. HTTP trusts the harness actor/permission/approval references
and belongs behind that authorized boundary. Memory results disappear on restart.
Persisted RUNNING records after crashes need an explicit recovery policy; automatically
repeating an unverified write would break the idempotency requirement. Mongo outages
during result/audit persistence need reconciliation before durable deployment.
