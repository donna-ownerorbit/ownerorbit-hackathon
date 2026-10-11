import { pathToFileURL } from "node:url";
import { normalizeHandle } from "../auth/handles.js";
import { collections, connect, disconnect } from "./mongodb.js";

export interface SeedOptions {
  ownerName: string;
  ownerHandles: string[];
  restaurantName: string;
  sandboxUrl: string;
}

export const DEMO_IDS = {
  tenantId: "tenant_demo",
  restaurantId: "rest_demo",
  ownerId: "user_owner_demo",
} as const;

/** Idempotent: safe to re-run; upserts one tenant, one restaurant and one authorized owner. */
export async function seed(opts: SeedOptions): Promise<void> {
  const { tenantId, restaurantId, ownerId } = DEMO_IDS;
  const now = new Date();

  await collections.tenants().updateOne(
    { _id: tenantId },
    { $set: { name: "OwnerOrbit Demo" }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  await collections.restaurants().updateOne(
    { _id: restaurantId },
    {
      $set: { tenantId, name: opts.restaurantName, platform: "ordersco", sandboxUrl: opts.sandboxUrl },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  await collections.users().updateOne(
    { _id: ownerId },
    {
      $set: { tenantId, name: opts.ownerName, handles: opts.ownerHandles.map(normalizeHandle), status: "active" },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  await collections.memberships().updateOne(
    { _id: `${ownerId}:${restaurantId}` },
    {
      $set: {
        tenantId,
        userId: ownerId,
        restaurantId,
        role: "owner",
        permissions: ["menu.write", "objectives.manage"],
      },
    },
    { upsert: true },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handles = (process.env.SEED_OWNER_HANDLES ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  if (handles.length === 0) throw new Error("Set SEED_OWNER_HANDLES in .env (your iMessage phone / Apple ID)");
  await connect();
  await seed({
    ownerName: process.env.SEED_OWNER_NAME ?? "Owner",
    ownerHandles: handles,
    restaurantName: process.env.SEED_RESTAURANT_NAME ?? "Demo Restaurant",
    sandboxUrl: process.env.SEED_SANDBOX_URL ?? "http://localhost:5173",
  });
  console.log(`Seeded tenant/restaurant/owner. Authorized handles: ${handles.map(normalizeHandle).join(", ")}`);
  await disconnect();
}
