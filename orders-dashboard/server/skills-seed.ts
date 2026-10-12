// Starting skills. Each is stored as version 1 in the `skills` collection the first time the
// agent runs; edits from the dashboard (or approved agent proposals) create new versions.
export const DEFAULT_SKILLS = [
  {
    skillId: 'menu-pricing',
    name: 'Menu pricing',
    description: 'Rules for changing prices so they stay consistent with the Falafel Flare menu board.',
    instructions: `Baseline: the printed menu board is the reference price list (e.g. Dolma $8.99, Gyro Wrap $12.99, Chicken Kabab $22.99, Flame Burger $16.99). Wraps and burgers can be made a meal (fries + soda) for +$4.99.

When asked to change prices:
1. Read the current item with get_item before proposing anything.
2. Keep prices ending in .99 unless the owner asks otherwise.
3. Never change a price directly. Use propose_price_change once per item; the owner approves it in the dashboard.
4. If a change is more than 15% from the current price, say so explicitly in the reason.
5. For "raise all X by $Y", propose one change per item in that category and summarize the list.
6. Keep size prices (e.g. Basket) consistent: mention them if the base price moves.`,
  },
  {
    skillId: 'availability-ops',
    name: 'Availability (86 list)',
    description: 'Marking items sold out, hidden, or back in stock.',
    instructions: `- "86", "out of", "ran out" → set_item_availability with status sold_out_today unless the owner says it's gone for good (sold_out) or should be removed from menus (hidden).
- "back", "restocked" → status available.
- Match item names loosely ("calamari" → Fried Calamari). If more than one item matches, list them and ask which.
- After the change, confirm using the verification evidence returned by the tool.
- If an item is sold out because of a supplier problem, remember it with the remember tool (topic: suppliers).`,
  },
  {
    skillId: 'order-triage',
    name: 'Order triage',
    description: 'Moving live orders through new → preparing → ready → completed.',
    instructions: `- Use search_orders to find live orders (status new, preparing, ready).
- Only move an order forward one step at a time unless asked otherwise. Never cancel an order without the owner explicitly asking.
- When summarizing, lead with orders waiting longest. Mention provider and item count.`,
  },
  {
    skillId: 'daily-briefing',
    name: 'Daily briefing',
    description: 'A short summary of sales, live orders, unavailable items and open objectives.',
    instructions: `Use sales_summary (days: 1 and 7), search_orders for live orders, get_menu for unavailable items, and list_objectives.
Write at most 8 short bullet points: sales vs last week, top sellers, anything unavailable, live orders needing attention, objective progress, and one suggested next action.`,
  },
  {
    skillId: 'objective-tracking',
    name: 'Objectives & follow-ups',
    description: 'Turning goals into tracked objectives with next actions and scheduled check-ins.',
    instructions: `- When the owner states a goal ("get burger sales up 10%", "launch a lunch special"), create_objective with a measurable target and 2–4 concrete next actions.
- Update progress with update_objective when evidence changes; mark actions done as they happen.
- If something needs checking later, schedule_followup with a specific time and a self-contained task description (the follow-up runs without this conversation's context).`,
  },
  {
    skillId: 'temporary-outage',
    name: 'Temporary 86 with auto-restore',
    description: '"Out until tomorrow" / "86 for tonight": mark unavailable now and schedule the restore.',
    instructions: `1. menu__item__set_availability with status sold_out_today for every item named; confirm each one verified.
2. Work out the restore time: "until tomorrow" = tomorrow 10:30 local unless business memory says otherwise; "tonight" = tomorrow opening; an explicit time wins.
3. schedule_followup with a self-contained task: "Mark <exact item names> available again and confirm verification", at = the restore time (ISO with offset).
4. Reply with the verified change and the restore time, e.g. "Chicken Nuggets 86'd on all 4 providers. I'll bring them back tomorrow 10:30am."
5. If the owner says how they like outages handled (e.g. "always restore at open"), remember it under topic preferences.`,
  },
  {
    skillId: 'catering-growth',
    name: 'Catering growth',
    description: 'Catering objectives: create_catering_page, qualify_lead, send_followup, create_quote, track_catering_order.',
    instructions: `Objective first: if there is no active catering objective, create_objective (metric "catering revenue per month", unit "$/month", baseline from insights__sales_report or what the owner says, target, deadline, constraints) with 2–4 interventions, then propose ONE intervention and ask for approval.
- create_catering_page: website__publish_page with slug "catering" — hero, office packages built from live menu items and prices (menu__lookup / the live catalog, never invented), how ordering works, lead time and minimums only if known (otherwise ask the owner, never invent a phone/email). Publishing is parked for the owner\'s YES by code; after it runs and verifies, update_objective → done with the live URL.
- qualify_lead: record as create_task kind task (title "Catering lead: <company>", details: headcount, date, budget, contact), assignee owner.
- send_followup: schedule_followup for the lead's follow-up date with a self-contained message draft.
- create_quote: price from menu__lookup (live prices only, never invent), list per-person cost and total, then handoff or reply with the quote; never commit to discounts without owner YES.
- track_catering_order: update_objective with the order value (current += value) and a note.
Always tie actions to the objective id.`,
  },
  {
    skillId: 'marketing',
    name: 'Marketing',
    description: 'launch_campaign, update_google_business, create_offer, message_customers, publish_social_content.',
    instructions: `No verified marketing skill exists yet, so every marketing action is a handoff (handoff_instructions) with exact copy and steps, linked to an objective when there is one.
- update_google_business: system "Google Business Profile"; give exact field values (hours from the dashboard, description, photos to add) and how to verify on Google Maps.
- create_offer / launch_campaign: system = the provider (DoorDash/Uber Eats/Grubhub merchant portal). State discount, eligible items (live names from the menu), dates, budget cap. Spending money → create_task kind approval_request first; wait for the owner.
- message_customers / publish_social_content: draft the message (≤ 2 short sentences + offer) and the audience; owner sends or approves.
Then schedule_followup a week later to measure the result with insights__sales_report and update_objective.`,
  },
  {
    skillId: 'operations',
    name: 'Operations',
    description: 'report_issue, assign_task, verify_closing, create_schedule, request_inventory_count.',
    instructions: `- report_issue: create_task kind issue (what, where, since when, impact). Equipment/food-safety issues are priority urgent and also escalate (kind escalation) to the owner.
- assign_task: create_task kind task with assignee and due time; schedule_followup at the due time to check it was done.
- request_inventory_count: create_task kind inventory_count for the items; when counts come back, menu__item__set_inventory with the numbers (verified) and update_task → done.
- verify_closing: create_task kind closing_check with the checklist (orders paused or store closed, 86 list reset, cash counted, equipment off); schedule_followup at closing time.
- create_schedule: business hours → schedule__set_hours; staff schedules → handoff (no staff system yet).`,
  },
  {
    skillId: 'management',
    name: 'Management',
    description: 'daily_report, objective_progress, detect_anomaly, request_approval, escalate_problem.',
    instructions: `- daily_report: insights__daily_brief, then add objective progress and open tasks; ≤ 8 lines.
- objective_progress: for each active objective, current vs target, % of gap closed, the next intervention and its status. If data is stale, pull insights__sales_report and update_objective.
- detect_anomaly: insights__sales_report for today and the last 30 days; flag >20% below the same weekday average, negative stock, items 86'd > 24h, or chargebacks piling up. Report the anomaly, the likely cause, and one proposed intervention.
- request_approval: spending, contracts, staff actions and price changes are never executed by you; create_task kind approval_request (or let code park the skill for YES).
- escalate_problem: create_task kind escalation, priority urgent, with what failed, what you tried, and what a human must do.`,
  },
  {
    skillId: 'github-briefs',
    name: 'Briefs from GitHub',
    description: 'Instructions committed to GitHub, pulled into MongoDB and handed to the agent.',
    instructions: `The message starts with "[GitHub update repo@sha by Name]" and contains the changed brief files.
1. Read the whole brief. Split it into: (a) concrete changes to the restaurant now (menu, availability, prices, hours, orders), (b) goals, (c) work for people, (d) facts/preferences.
2. (a) run the matching skill tools; price changes, deletes and publishing are parked for the owner's YES automatically. Only report a change as done if verification ok.
3. (b) create_objective or update_objective; (c) create_task / handoff_instructions / schedule_followup; (d) remember.
4. If the brief changes how a procedure should work, propose_playbook_update for that playbook (one per brief).
5. Reply: one line on what changed (verified), one line on what is waiting for approval, then "Suggested next actions:" as a numbered list (max 5), each concrete and owned.`,
  },
]
