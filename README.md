# OwnerOrbit

Restaurant owners text **Donna** over iMessage; OwnerOrbit identifies the sender, checks permissions, plans with a grammar fast path or a Claude Haiku agent, acts on the restaurant's real ordering dashboard, verifies the result by re-reading it, scores every turn with deterministic evals (Raindrop), and keeps the business brain in MongoDB Atlas.

```
iMessage → BlueBubbles webhook → ownerorbit /messages/inbound → MongoDB inbox → identity + RBAC
  → grammar or Haiku agent (skills + playbooks + objectives + memory)
  → execution: browser-exec (verified Playwright skills) or built-in skills / dashboard API
  → verify (independent re-read) → evals → Raindrop + MongoDB → reply via BlueBubbles
```

| Directory | What it is |
|---|---|
| `ownerorbit/` | Donna core: inbox worker, identity/RBAC, Haiku agent, 30 skills, approvals, objectives, follow-ups, evals, mock iMessage demo (`/phone`) |
| `browser-exec/` | Deterministic browser execution + confirmation agents with Raindrop tracing (called by the core for availability and price changes) |
| `orders-dashboard/` | The restaurant dashboard (Vite + React + Vercel function on MongoDB), including public pages at `/p/:slug` |

## Run the demo
```
cd browser-exec && npm ci && npm run dev          # :4001
cd ownerorbit && npm ci && npm run server         # :8787 → open http://localhost:8787/phone
npm run demo:imessage                             # same script in the terminal
npm run demo:reset                                # between rehearsals
```
Each package has its own `.env.example`; copy to `.env` / `.env.local` and fill in MongoDB, Anthropic, BlueBubbles and Raindrop credentials. See `ownerorbit/README.md` for the inbox contract, demo script and evals.
