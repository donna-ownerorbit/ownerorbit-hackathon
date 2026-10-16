# OwnerOrbit core

## Demo topology (one path, no double replies)
```
iPhone ──iMessage──▶ Mac: Messages.app + BlueBubbles Server
                         │ webhook (New Messages) → http://localhost:8787/messages/inbound?secret=…
                         ▼
                 OwnerOrbit server (npm run server)
                         │ insert
                         ▼
          MongoDB Atlas ownerorbit.inbound_messages ◀── any other adapter can insert here too
                         │ worker claims (one message per sender at a time, any number of workers)
                         ▼
   identity (principals + harness users/memberships) → grammar ─┬─▶ skill (Playwright on the Vercel dashboard / dashboard API)
                                                                 └─▶ Claude Haiku agent (skills + playbooks + objectives + memory)
                         │ re-read the live site → verification checks → agent_actions / agent_runs
                         ▼
     reply → outbound_messages → BlueBubbles REST /api/v1/message/text → iPhone
```
Point BlueBubbles' webhook **only** at OwnerOrbit. If the team harness (`harness/`) also gets the webhook, both answer. To run the harness as the front door instead, give it the webhook and set `HARNESS_BRIDGE=fallback` here.

Conversation state (pending YES, undo history) lives in `conversations`, so a "YES" works no matter which worker picks it up.

## Demo without BlueBubbles (fallback that always works)
Everything except Apple's delivery is the real system: the mock phone fires the exact BlueBubbles "new-message" webhook at `/messages/inbound`, Donna replies through a BlueBubbles-compatible REST stand-in (`/mock-bluebubbles/api/v1/message/text`), and identity, inbox, grammar/Haiku, skills, browser-exec, verification and evals are all live.

1. Start the stack (two terminals):
   ```
   cd ~/ownerorbit-hackathon/browser-exec && npm run dev      # Abdullah's browser-exec on :4001 (optional; built-in skills take over if it's down)
   cd ~/ownerorbit && npm run server                            # Donna on :8787
   ```
2. Open **http://localhost:8787/phone**: an iPhone with the iMessage thread on the left and the live Vercel site on the right. Tap the suggestion chips (or type). The website pane follows Donna's changes (menu after an 86, `/p/catering` after a publish); tap the gray line under a reply for the skills that ran, verification, and every eval.
3. No browser? `npm run demo:imessage` runs the same script in the terminal (or `npm run demo:imessage -- "86 the wings"`).
4. Between rehearsals: `npm run demo:reset` (nuggets available, catering page + demo objective removed, thread cleared).

The phone texts from `DEMO_PHONE` (default +15550001234, registered as owner automatically) on a `mock;-;…` chat, so it never sends a real iMessage even when BlueBubbles is live. `BLUEBUBBLES_MODE=auto` uses the real BlueBubbles server for real chats once `BLUEBUBBLES_URL` + `BLUEBUBBLES_PASSWORD` are set; `mock` forces the stand-in for everything.

## Raindrop + evals
Every message gets deterministic evals (`src/telemetry/evals.ts`): `honest_claim`, `verified`, `task_completed`, `first_try`, `approval_respected`, `fast_enough`, `providers_consistent`. They're stored on the inbox document (`inbound_messages.evals`), shown under each reply on /phone, logged as `🧪 evals n/n`, and, with `RAINDROP_WRITE_KEY` set, sent to Raindrop as `eval_<name>_pass|fail` signals on the same interaction as the tool spans, with `selfDiagnose` on failures. browser-exec sends its own `skill_execution` interactions with the same eval names, so both layers land in one Raindrop project (set the same key in `browser-exec/.env`).

## Demo script (text these to Donna)
1. `mark chicken nuggets out of stock` → grammar → dashboard → "verified ✓"
2. `nuggets are back`
3. `we need a corporate catering page on our website to grow catering to 15k a month — we do about 6k now` → Haiku creates the objective, builds the page from the live menu, parks it for approval
4. `YES` → page published at `<dashboard>/p/catering`, verified in a fresh browser tab, objective intervention marked done, next step proposed
5. `our doordash listing still shows the old hours, how do I fix that` → step-by-step handoff (saved in `handoffs`)
6. `what's 86'd right now` · `morning brief` · `undo`

Rehearse without a phone: `npm run imessage -- +1510XXXXXXX "<text>"` (needs the number registered and the server running).

iMessage → MongoDB inbox → identity/RBAC → grammar or Claude Haiku agent → skills (Playwright on the dashboard) → verify → MongoDB evidence → reply.

## Run
```
npm run imessage -- +15105551234 "is the flame burger available?"   # BlueBubbles-shaped webhook → full pipeline
npm run preflight     # checks selectors, Atlas, inbox, playbooks, principals, Haiku, BlueBubbles
npm run server        # HTTP (BlueBubbles webhook, /simulate, /health, /inbox) + inbox worker
npm run worker        # inbox worker only, if something else writes iMessages into MongoDB
npm run principals -- add +15105551234 owner "Saddiq Jeelani"
npm run inbox -- send +15105551234 "mark chicken nuggets out of stock"   # acts like an adapter, waits for the reply
npm run inbox -- tail
```
`.env.local`: `MONGODB_URI`, `MONGODB_DB=ownerorbit`, `RESTAURANT_ID=falafel-flare`, `ANTHROPIC_API_KEY`, optional `BLUEBUBBLES_*`, `RAINDROP_WRITE_KEY`.

## Inbox contract (for any iMessage adapter)
Insert into `ownerorbit.inbound_messages`:
```json
{ "from": "+15105551234", "text": "86 the nuggets", "messageId": "<bluebubbles guid>", "chat": "iMessage;-;+15105551234" }
```
Only `from` and `text` are required; `messageId` makes webhook retries idempotent (unique index). The worker picks it up within ~1s (change stream; 10s polling fallback), sets `status` `processing → done | ignored | failed` and writes `reply`, `planner`, `results[]` (skill, outcome, verified, actionId) back onto the same document. The reply is also queued in `outbound_messages` (`status: pending`); with `BLUEBUBBLES_URL` set the worker sends it and marks it `sent`, otherwise your adapter sends the `pending` rows.
The built-in webhook (`POST /messages/inbound?secret=…`) does exactly this insert.

## Who decides what
| Decision | Owner |
|---|---|
| Who is texting, which role | code — `principals` collection + `OWNERORBIT_PRINCIPALS` env |
| Is the role allowed to run the skill | code — `Executor.preflight` (`minRole`) |
| Needs the owner's YES | code — skill `confirm()` + `APPROVAL_REQUIRED` (prices, deletes, publish); the YES is matched by the grammar, never the model |
| Did it work | code — every write skill reloads the dashboard and re-reads state (`verification.checks`) |
| What to do | grammar for routine commands; Claude Haiku (`claude-haiku-5-5`) for everything else |

## What Haiku can use
All 29 skills as tools, plus the MongoDB business brain (`src/agent/brain.ts`):
- **Playbooks**: the dashboard's versioned `skills` collection. Haiku loads one with `get_playbook` before acting and records which version guided each run. When a playbook is wrong it files `propose_playbook_update` → owner approves on the dashboard **Skills** page → new version.
- **Objectives** (`objectives`): baseline → target → deadline, interventions with status, progress log.
- **Memory** (`business_memory`), **follow-ups** (`followups`, run by the worker when due, as the person who scheduled them, with the reply sent to their chat), **handoffs** (`handoffs`: numbered steps for DoorDash/Uber Eats/Grubhub/Google work no skill can do).
- **Traces** (`agent_runs`): model, playbook versions, every tool call with result, token usage, and whether approval is pending. Step evidence stays in `agent_actions`; Raindrop gets the same spans when `RAINDROP_WRITE_KEY` is set.

## GitHub briefs → MongoDB → Haiku
Saddiq's side commits instructions/briefs (Markdown) to a GitHub repo. The worker pulls the branch every `GITHUB_POLL_MS` (or instantly via `POST /github/webhook`), stores each new commit in `ownerorbit.github_commits` (sha, author, message, changed files with diff + full text at that commit), and queues it in the inbox as `github:<sha>`. It then goes through the same core as an iMessage: the commit author must map to a principal (`--github <login>` on `npm run principals`, or `GITHUB_PRINCIPALS`), RBAC and the owner-YES rules apply, Haiku follows the `github-briefs` playbook, every dashboard change is verified, and the reply ("…Suggested next actions:") is written back onto the commit doc and texted to the author, who can answer YES on iMessage.
```
npm run principals -- add +15105551234 owner "Saddiq Jeelani" --github saddiq-login
npm run github -- pull --dry     # MongoDB pulls from GitHub only
npm run github -- pull           # pull + run the agent (needs a worker running: npm run server / worker)
npm run github -- status         # commits + what the agent did
npm run github -- replay <sha>
```
Unmapped authors and commits outside `GITHUB_PATHS` are stored as `skipped` and never executed. Pulls are idempotent (unique repo+sha). First pull takes only the latest `GITHUB_BACKFILL` commits.

## Playbooks for the brief's skill registry
On the dashboard Skills page (versioned in MongoDB `skills`): availability-ops, temporary-outage (86 + scheduled restore), menu-pricing, order-triage, daily-briefing, objective-tracking, catering-growth, marketing, operations, management, github-briefs. Operations/management skills (report_issue, assign_task, request_inventory_count, verify_closing, escalate_problem, request_approval) are the `create_task` / `update_task` tools over MongoDB `tasks`. Catering pages, marketing and third-party portals are handoffs until a verified skill exists.

### Chat over GitHub (demo transport, no connector needed)
A file added under `messages/` (`GITHUB_MESSAGES_DIR`) is one chat message, handled exactly like an iMessage (grammar first, Haiku for the rest, "yes"/"no"/"undo" work). The agent commits its reply to `replies/<sha>.md` (`GITHUB_REPLIES_DIR`) and stores it on the commit doc in MongoDB; its own reply commits are skipped, so there is no loop. Round trip ≈ 4–10s with `GITHUB_POLL_MS=5000`.
```
npm run github -- send "86 the chicken nuggets"   # commits messages/<timestamp>.txt
```

## Team harness bridge (iMessage via donna-ownerorbit/ownerorbit-hackathon)
The team harness (`harness/` on branch `claude/mongodb-imessage-integration-lcsqyc`) owns the BlueBubbles webhook and logs every iMessage to the shared Atlas DB (`audit_events`: `message.received`, and `intent.unknown` when its regex parser can't handle it). `src/inbox/harness-bridge.ts` tails those events (change stream + 1.5s poll, cursor in `bridge_state`, starts from "now") and queues them in Donna's inbox as `harness:<bluebubbles guid>`, acting as the user/role the harness authenticated (`users.handles`, `memberships.role`).
- `HARNESS_BRIDGE=fallback` (default): only messages the harness couldn't parse → Haiku/skills. Nuggets/price commands stay with the harness, so nothing runs twice.
- `HARNESS_BRIDGE=all`: every message (only if the harness stops acting itself). `off`: disabled.
- Replies go out via BlueBubbles (`BLUEBUBBLES_URL`/`PASSWORD`, same server as the harness) and are recorded in `outbound_messages`.
- The worker also polls that GitHub branch and warns when a commit touches the harness files the bridge reads (`GITHUB_WATCH_FILES`).
