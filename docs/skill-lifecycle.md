# Skill lifecycle

A skill is a verified procedure on one platform (e.g. `ordersco.item.set_availability`).
Skills are code + a registry entry + tests + a page map.

```
requested → mapped → draft → shadow → supervised → live → (v2 …) → deprecated
```
| Status | Meaning |
|---|---|
| requested | An owner asked; a `skill_request` exists |
| mapped | Pages and selectors documented from screenshots or a logged-in session |
| draft | Code exists, runs on the clone/demo site only |
| shadow | READ skills run on the live portal; writes still blocked |
| supervised | Writes on the live portal only with a human approving each run |
| live | Owners can trigger it; confirmation rules still apply |
| deprecated | Replaced by a newer version; kept for rollback |

## Rules
- READ before WRITE on every platform.
- Every write has: preconditions, execute, independent re-read verify, rollback value.
- Version bump (`v1` → `v2`) when selectors or behavior change; registry keeps both until v2 is live.
- One skill per action; restaurants opt in per skill in their profile.
- The assessor flags skills whose verification failure rate rises (site changed) → demote to supervised.

## Building a skill (checklist)
1. Log in by hand in a Playwright persistent profile `.profiles/<platform>-<restaurant>/`.
2. Map pages → `ownerorbit/src/skills/<platform>/README.md`.
3. Build READ skill → compare to portal → `shadow`.
4. Build WRITE skill → one cheap item, verify, undo, with a human → `supervised`.
5. Tests + registry entry + profile opt-in → PR → `live`.
6. Session expiry: detect login page, alert admin "login needed for <restaurant>"; never fail silently.
