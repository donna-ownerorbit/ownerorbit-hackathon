# Request funnel

```
message → identity (phone → person) → permission (role per restaurant)
        → category + domain → skill match?
            yes → confirm (by risk) → execute → verify → log → reply
            no  → clarify (max 2 questions) → 48h offer → skill_request → alert Saddiq
```

## Categories (exactly one per message)
| Category | Example | Route |
|---|---|---|
| INFO | "what's sold out", "sales this week" | Answer from stored/live-read data + one next step with $ value |
| ACTION | "86 the falafel wrap", "hummus to $8.99" | Skill (if live for that restaurant) else 48h |
| CREATE | "make a catering page", "new logo", "add photos" | 48h build request |
| AUTOMATE | "do my inventory", "payroll" | Discovery questions → 48h scope |
| ISSUE | "DoorDash shows wrong hours", complaint, customer feedback | Log, fix via skill or route to human |
| GOAL | "catering from 6k to 15k" | Store objective (baseline, target, deadline) |
| ADMIN | "add my manager", billing | Owner only; human confirms |
| UNCLEAR | anything ambiguous | One clarifying question |

## Roles
owner > gm > manager > staff. Roles are per restaurant. Admin (OwnerOrbit team) can act on all.

## Confirmation by risk
| Risk | Examples | Rule |
|---|---|---|
| read | sold-out list, prices, orders | none |
| low write | availability, hours | "YES" |
| medium write | price, add-on price | "YES" with old → new and % |
| high write | price change >15%, deletes, publish | "YES CONFIRM" |
| money / contracts | spend, refunds, disputes, orders to vendors | owner "YES CONFIRM" + admin review |
Every write: verify by re-reading; "undo" reverts the last change; max 20 writes/owner/day.
