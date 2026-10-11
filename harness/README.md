# OwnerOrbit harness

Restaurant owners text Donna over iMessage; OwnerOrbit authenticates the sender, checks permissions in MongoDB, runs a trusted skill against the restaurant's ordering platform, verifies the result and replies.

```
iMessage -> BlueBubbles webhook -> /messages/inbound -> authenticate (users.handles)
  -> intent -> authorize (memberships.permissions) -> owner_requests -> browser-exec /execute (skill + verify) -> audit -> reply
```

## MongoDB collections

| Collection | Purpose |
|---|---|
| `tenants` | Top-level isolation boundary; every query filters by `tenantId` |
| `restaurants` | Restaurant + its Orders.co sandbox URL |
| `users` | People; `handles` = iMessage phone numbers / Apple IDs (unique) |
| `memberships` | user ↔ restaurant role and `permissions` (RBAC) |
| `owner_requests` | Each owner request; unique `idempotencyKey` (iMessage guid) prevents double execution. browser-exec writes its own `action_runs` |
| `objectives` | Long-horizon goals (metric, baseline, target, deadline) |
| `audit_events` | Every material transition, including denials |

## Run

```bash
npm install
cp .env.example .env        # fill MONGODB_URI and SEED_OWNER_HANDLES
npm run seed
npm run dev
curl localhost:3000/health
curl -X POST localhost:3000/messages/inbound -H 'content-type: application/json' \
  -d '{"from":"+15555550100","text":"Mark chicken nuggets out of stock.","messageId":"test-1"}'
```

Tests: `npm test` (in-memory MongoDB), or `TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test`.

All code in this repo was written during the hackathon. External infrastructure: MongoDB Atlas, BlueBubbles, Orders.co sandbox.
