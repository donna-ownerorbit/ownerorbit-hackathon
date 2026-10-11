import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";
import { collections, connect, disconnect } from "../src/db/mongodb.js";
import { DEMO_IDS, seed } from "../src/db/seed.js";
import { createApp } from "../src/server.js";

// Uses TEST_MONGODB_URI (e.g. a local docker mongo) when set, otherwise an in-memory MongoDB.
let mongo: MongoMemoryServer | undefined;
let server: Server;
let base: string;

before(async () => {
  let uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    mongo = await MongoMemoryServer.create();
    uri = mongo.getUri();
  }
  await connect(uri, `ownerorbit_test_${Date.now()}`);
  await seed({
    ownerName: "Saddiq",
    ownerHandles: ["(555) 555-0100", "Owner@Example.com"],
    restaurantName: "Test Restaurant",
    sandboxUrl: "http://localhost:5173",
  });
  // A second user with no menu permission, to prove RBAC denies.
  await collections.users().insertOne({
    _id: "user_viewer", tenantId: DEMO_IDS.tenantId, name: "Viewer", handles: ["+15555550199"], status: "active", createdAt: new Date(),
  });
  await collections.memberships().insertOne({
    _id: "user_viewer:rest_demo", tenantId: DEMO_IDS.tenantId, userId: "user_viewer", restaurantId: DEMO_IDS.restaurantId, role: "manager", permissions: [],
  });
  process.env.SKILL_URL = "http://127.0.0.1:9";
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await disconnect();
  await mongo?.stop();
});

const inbound = (body: unknown) =>
  fetch(`${base}/messages/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("/health reports mongo ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, mongo: true });
});

test("known owner is accepted and an action_run is stored", async () => {
  const res = await inbound({ from: "+1 555-555-0100", text: "Mark chicken nuggets out of stock.", messageId: "msg-1" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intent.itemName, "chicken nuggets");
  const run = await collections.actionRuns().findOne({ idempotencyKey: "msg-1" });
  assert.equal(run?.status, "failed"); // browser-exec not running in this test -> honest failure
  assert.equal(run?.tenantId, DEMO_IDS.tenantId);
  assert.deepEqual(run?.params, { itemId: "kids-chicken-nuggets-with-fries", available: false });
});

test("email handle is matched case-insensitively", async () => {
  const res = await inbound({ from: "owner@example.COM", text: "chicken nuggets back in stock", messageId: "msg-2" });
  assert.equal(res.status, 200);
});

test("duplicate message does not create a second action_run", async () => {
  const res = await inbound({ from: "+15555550100", text: "Mark chicken nuggets out of stock.", messageId: "msg-1" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  assert.equal(await collections.actionRuns().countDocuments({ idempotencyKey: "msg-1" }), 1);
});

test("unknown sender is denied and audited", async () => {
  const res = await inbound({ from: "+19999999999", text: "Mark chicken nuggets out of stock." });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "unknown_sender");
  assert.ok(await collections.auditEvents().findOne({ type: "message.denied.unknown_sender" }));
});

test("user without permission is denied", async () => {
  const res = await inbound({ from: "+15555550199", text: "Mark chicken nuggets out of stock." });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "missing_permission");
});

test("objectives can be stored", async () => {
  const now = new Date();
  await collections.objectives().insertOne({
    tenantId: DEMO_IDS.tenantId, restaurantId: DEMO_IDS.restaurantId, userId: DEMO_IDS.ownerId,
    text: "Grow weekly orders 10%", metric: "weekly_orders", baseline: 100, target: 110, status: "active", createdAt: now, updatedAt: now,
  });
  assert.equal(await collections.objectives().countDocuments({ tenantId: DEMO_IDS.tenantId }), 1);
});

test("BlueBubbles webhook runs the skill and replies over iMessage", async () => {
  const { createServer } = await import("node:http");
  const sent: any[] = [];
  const skillCalls: any[] = [];
  const fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      if (req.url === "/execute") { skillCalls.push(body); return res.end(JSON.stringify({ status: "VERIFIED", message: "Done. Verified.", evidence: [], attempts: 1 })); }
      sent.push(body);
      res.end("{}");
    });
  }).listen(0);
  const fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.SKILL_URL = fakeBase;
  process.env.BLUEBUBBLES_URL = fakeBase;
  process.env.BLUEBUBBLES_PASSWORD = "pw";
  try {
    const res = await fetch(`${base}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "new-message",
        data: { guid: "bb-1", text: "Mark chicken nuggets out of stock", isFromMe: false, handle: { address: "+15555550100" }, chats: [{ guid: "iMessage;-;+15555550100" }] },
      }),
    });
    assert.equal(res.status, 200);
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent[0]?.chatGuid, "iMessage;-;+15555550100");
    assert.match(sent[0]?.message, /Done/);
    const run = await collections.actionRuns().findOne({ idempotencyKey: "bb-1" });
    assert.equal(run?.status, "verified");
    assert.equal(skillCalls[0].skillId, "middleware.mark_item_unavailable");
    assert.deepEqual(skillCalls[0].inputs, { itemId: "kids-chicken-nuggets-with-fries" });
    assert.deepEqual(skillCalls[0].actor.permissions.includes("menu.write"), true);
  } finally {
    delete process.env.SKILL_URL;
    delete process.env.BLUEBUBBLES_URL;
    fake.close();
  }
});

test("price change: quote, YES approval, then verified execution", async () => {
  const { createServer } = await import("node:http");
  const calls: any[] = [];
  const fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push(body);
      res.setHeader("content-type", "application/json");
      const before = { name: "Kids Chicken Nuggets", price: 6.99 };
      if (!body.approvalId) return res.end(JSON.stringify({ status: "NEEDS_APPROVAL", message: "Owner approval required.", before, evidence: [], attempts: 0 }));
      res.end(JSON.stringify({ status: "VERIFIED", message: "Done. Verified.", before, after: { ...before, price: body.inputs.newPrice }, evidence: [], attempts: 1 }));
    });
  }).listen(0);
  process.env.SKILL_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  try {
    const quote = await inbound({ from: "+15555550100", text: "change price of nuggets to $1 higher", messageId: "p-1" });
    assert.equal(quote.status, 202);
    const q = await quote.json();
    assert.equal(q.oldPrice, 6.99);
    assert.equal(q.newPrice, 7.99);
    assert.equal(calls.length, 1);

    const yes = await inbound({ from: "+15555550100", text: "YES", messageId: "p-2" });
    assert.equal(yes.status, 200);
    assert.equal((await yes.json()).status, "verified");
    assert.equal(calls[1].skillId, "middleware.change_price");
    assert.deepEqual(calls[1].inputs, { itemId: "kids-chicken-nuggets-with-fries", newPrice: 7.99 });
    assert.ok(calls[1].approvalId);
    assert.ok(calls[1].actor.permissions.includes("pricing.write"));

    const again = await inbound({ from: "+15555550100", text: "yes", messageId: "p-3" });
    assert.equal((await again.json()).error, "nothing_pending");
    assert.equal(calls.length, 2);
  } finally {
    delete process.env.SKILL_URL;
    fake.close();
  }
});
