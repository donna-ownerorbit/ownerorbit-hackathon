// npm run db:check — verifies MONGODB_URI works and shows what browser-exec has written.
// Never prints the URI.
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) { console.log("MONGODB_URI is empty → executor uses the in-memory store. Set it in .env to persist."); process.exit(0); }
const dbName = process.env.MONGODB_DB || "ownerorbit";
const runsName = process.env.MONGODB_RUNS_COLLECTION || "action_runs";
const auditName = process.env.MONGODB_AUDIT_COLLECTION || "audit_events";

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  console.log(`✓ Connected to Atlas. Database: ${dbName}`);
  const d = client.db(dbName);
  const names = (await d.listCollections().toArray()).map((c) => c.name);
  console.log(`  collections: ${names.join(", ") || "(none yet — they appear after the first run)"}`);
  for (const n of [runsName, auditName]) {
    const c = d.collection(n);
    const count = await c.countDocuments();
    const last = await c.find({}, { projection: { _id: 0, runId: 1, status: 1, event: 1, skillId: 1, tenantId: 1 } })
      .sort({ _id: -1 }).limit(3).toArray();
    console.log(`  ${n}: ${count} docs; latest: ${JSON.stringify(last)}`);
  }
} catch (e: any) {
  const msg = String(e?.message ?? e);
  console.error("✗ Mongo check failed:", msg.replace(/mongodb(\+srv)?:\/\/[^@\s]+@/g, "mongodb$1://***@"));
  if (/whitelist|IP|timed out|Server selection/i.test(msg)) console.error("  → Likely your IP isn't allowed: Atlas → Network Access → Add Current IP Address.");
  if (/auth|bad auth|Authentication/i.test(msg)) console.error("  → Username/password in MONGODB_URI is wrong.");
  if (/EBADNAME|querySrv/i.test(msg)) console.error("  → MONGODB_URI is malformed or still a placeholder.");
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
