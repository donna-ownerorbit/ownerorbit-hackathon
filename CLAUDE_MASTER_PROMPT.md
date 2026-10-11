# MASTER PROMPT FOR CLAUDE CODE

You are the lead implementation engineer for a hackathon project called OwnerOrbit.

Read `OWNERORBIT_HACKATHON_MASTER.md` completely before writing code.

## Operating rules
1. Build sequentially from Phase 0 through Phase 7.
2. Keep the app runnable after every phase.
3. Do not over-engineer.
4. Do not build a dashboard.
5. Prefer deterministic code for security, permissions, execution and verification.
6. The LLM may interpret intent and plan; it must not decide identity, authorization, or whether an external action actually succeeded.
7. Use MongoDB Atlas hackathon sandbox for persistent data.
8. Use TypeScript + Node.js + Express unless there is a concrete blocker.
9. Use Playwright for browser automation if no stable API is available.
10. Never put production credentials or secrets into prompts, source code, Git, or MongoDB plaintext.
11. Preserve tenant isolation in every query.
12. Store an audit event for every material transition.
13. Verify external state after every write.
14. Do not claim success until verification succeeds.
15. All submitted code must be work created during the hackathon. Clearly label pre-existing external infrastructure/dependencies.

## First milestone
Build only enough to make this work:

Input:
`Mark chicken nuggets out of stock.`

Pipeline:
`authorized sender -> restaurant -> permission -> intent -> trusted skill -> real middleware -> verify -> action_run/audit -> response`

Do not proceed to iMessage or long-horizon objectives until this works locally through an HTTP request.

## Required repo shape
Use a simple structure:

```text
src/
  server.ts
  config.ts
  db/
    mongodb.ts
  auth/
    authenticate.ts
    authorize.ts
  agent/
    harness.ts
    intent.ts
  skills/
    registry.ts
    markItemUnavailable.ts
  tools/
    middlewareBrowser.ts
  verification/
    verifyAvailability.ts
  audit/
    audit.ts
  routes/
    messages.ts
  adapters/
    messaging.ts
    bluebubbles.ts
```

You may adjust names if necessary, but keep equivalent separation of concerns.

## Work style
For every phase:
1. Tell me the exact files you will create/change.
2. Implement the smallest working version.
3. Give me exact install/run commands.
4. Give me a concrete test request.
5. State PASS/FAIL criteria.
6. Stop if the phase does not work; debug it before moving on.
7. Commit at each phase boundary.

## Start now
Begin with Phase 0 and Phase 1 only:
- bootstrap TypeScript/Express
- MongoDB connection
- `/health`
- collections
- seed one tenant, restaurant and authorized owner
- `/messages/inbound`
- authentication + RBAC

Do not yet implement Playwright, iMessage, objectives, or recursive skill improvement.
