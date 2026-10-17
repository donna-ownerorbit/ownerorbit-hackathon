# Weekly bottleneck loop (one constraint per restaurant per week)

Every restaurant has one objective at a time (e.g. "catering $6k → $15k/mo by Dec 31").
Each week we find the **single biggest constraint** on that objective, remove only that, and measure.
Everything else waits. This is how we stay focused and prove value in dollars every week.

## The loop (runs every Monday, per restaurant)
1. **Objective check**: current value vs. target, from real data. Gap in $.
2. **Find the constraint**: walk the funnel for that objective and find the step losing the most $.
   Funnel = discovery → intent → order → fulfillment → relationship → repeat (see docs/domains.md).
3. **Size it**: estimated $ per month unlocked if removed. Show the math.
4. **Pick ONE action** that removes or loosens it this week, with an owner YES.
   Prefer: existing live skill > manual-by-us (becomes a skill) > 48h new skill.
5. **Execute and verify** during the week (Donna logs every step).
6. **Measure on Sunday**: did the metric move? Record in the restaurant profile.
7. **Decide**: constraint gone → find the next one. Still there → stronger action or rethink.

## Rules
- One bottleneck per restaurant per week. Never more than one active.
- Always in dollars. "Cancellations cost you ~$410/mo; 60% are 'item unavailable'."
- Delete before automate: first ask whether the step should exist at all, then simplify, then speed up, then automate.
- Constraints in a domain we have no skill for still count: we name them and offer the 48h fix.

## Monday text to the owner (template)
> This week's #1 thing holding back [objective]: [constraint] (about $[X]/mo).
> My plan: [one action]. Reply YES and I'll do it. Last week: [result vs. expectation].

## Where it is recorded
`restaurants/<id>/profile.md` → "Weekly bottleneck log" (date, objective gap, constraint, $ size,
action, result). The nightly digest lists any restaurant without an active bottleneck.
