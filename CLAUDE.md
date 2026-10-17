# OwnerOrbit — read this first (humans and agents)

OwnerOrbit gives every independent restaurant its own AI agent, **Donna**, reachable by text.
Owners and staff text a request; Donna checks who they are and what they may do, matches the
request to a verified skill, asks for confirmation when needed, executes, re-reads the real
system to verify, logs everything, and reports back in plain words and dollars.

North star per restaurant: more orders, more catering, more units (franchise). Every action
should move one of: GMV, 3P→1P conversion, repeat rate, AOV, contribution margin, catering leads.

## Non-negotiable rules
1. **Identity and permission are code, never the model.** Unknown numbers get silence (logged).
2. **No write without a registered skill** for that restaurant + platform, at status `live`.
3. **Every write needs the right confirmation** (see `docs/request-funnel.md`) and is **verified by
   re-reading the real system**. If verification fails, say so. Never claim "done" without proof.
4. **No skill? No improvising.** Reply with the 48-hour promise and create a `skill_request`.
5. **Tenant isolation.** A restaurant's data never appears in another restaurant's reply.
6. **Secrets live only in `.env.local` and browser profiles (`.profiles/`), never in git, logs or chat.**
7. **Everything is logged**: message, category, domain, skill, approval, result, verification.

## Where things live
| Path | What |
|---|---|
| `ownerorbit/` | Donna core: iMessage transport, identity, planner, skills, verification, inbox worker |
| `ownerorbit/src/skills/` | Skill code. One folder per platform for live-portal skills (e.g. `ordersco/`) |
| `skills/registry.yaml` | Every skill: id, platform, read/write, risk, status, version, owner. **Source of truth.** |
| `restaurants/<id>/profile.md` | One per restaurant: owners, systems, access status, objectives, notes |
| `docs/domains.md` | The full map of restaurant domains so nothing is a blind spot |
| `docs/request-funnel.md` | Message → identity → category → skill or 48h request |
| `docs/skill-lifecycle.md` | How a skill is born, tested, versioned, promoted and retired |
| `docs/weekly-bottleneck.md` | One objective, one constraint per week per restaurant, always in $ |
| `docs/vendors.md` | Every third-party service, cost, and why it is (or isn't) used |
| `orders-dashboard/` | Demo/clone site used to build and test skills before touching live portals |
| `browser-exec/`, `harness/` | Hackathon-era modules. Not on the live path; keep until reviewed |

## Run (on the Mac that hosts iMessage)
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ownerorbit && npm install && npx playwright install chromium
npm run preflight && npm run server        # Donna on :8787
```
BlueBubbles webhook: `http://localhost:8787/messages/inbound?secret=<BLUEBUBBLES_WEBHOOK_SECRET>`.

## Operating cadence
Every Monday, per restaurant: run the weekly bottleneck loop (`docs/weekly-bottleneck.md`).
One active constraint per restaurant, sized in dollars, one action, measured by Sunday.

## Working agreement for agents
- Read the restaurant's `profile.md` and the relevant `registry.yaml` entries before acting.
- New skill or change → branch, tests, update `registry.yaml` + docs, PR. Never push to `main`.
- Live-portal writes during development: ask the human first, one cheap item, then undo.
