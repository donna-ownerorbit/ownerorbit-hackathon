# Vendors and services (keep this honest)

| Service | Used for | Cost | Status |
|---|---|---|---|
| Anthropic API (Claude Haiku 5.5) | Understanding free-form messages | $0.10 / $0.50 per M tokens, from credits | In use |
| BlueBubbles + Mac | iMessage transport | $0 (Mac must stay awake) | In use |
| GitHub (private repo) | Code, docs, registry | $0 | In use |
| MongoDB Atlas M0 | Messages, requests, actions, memory | $0 | Planned (needed for visibility) |
| Vercel | Demo/clone sites, ownerorbit.ai | $0 Hobby; Pro needed once commercial | Planned |
| Playwright | Driving portals without APIs | $0 | In use |
| Stripe | Collecting payments (Payment Links) | per-transaction fee only | Planned |
| WhatsApp Cloud API (Meta) | Always-on messaging without a Mac | owner-initiated conversations free | Later |
| VPS (~$5/mo) | Run Donna 24/7 off the laptop | ~$5/mo | Later |
| Raindrop | Eval dashboards | — | Not used; assessor stores evals in Mongo |
| Mem0 / Zep / LangChain | Memory / agent frameworks | — | Not needed; Mongo + our own skill registry |

Rule: add a vendor only when a live restaurant need requires it. Record it here first.
