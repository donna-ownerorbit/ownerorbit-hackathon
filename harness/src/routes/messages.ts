import { randomUUID } from "node:crypto";
import { Router } from "express";
import { MongoServerError, type ObjectId } from "mongodb";
import { authenticate } from "../auth/authenticate.js";
import { authorize } from "../auth/authorize.js";
import { parseIntent } from "../agent/intent.js";
import { audit } from "../audit/audit.js";
import { collections, type ActionRunStatus, type User } from "../db/mongodb.js";
import { parseWebhook, sendText } from "../adapters/bluebubbles.js";
import { executeSkill, isSuccess, resolveItemId, type ExecuteResult } from "../skills/browserExec.js";

export const messagesRouter = Router();

interface Inbound {
  from: string;
  text: string;
  messageId?: string;
  restaurantId?: string;
}

interface Outcome {
  status: number;
  body: Record<string, unknown>;
  /** Text to send back to the owner over iMessage; null means stay silent (e.g. unknown sender). */
  reply: string | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/** The single pipeline every channel uses: authenticate -> intent -> authorize -> request -> browser-exec -> reply. */
export async function handleInbound({ from, text, messageId, restaurantId }: Inbound): Promise<Outcome> {
  const user = await authenticate(from);
  if (!user) {
    await audit("message.denied.unknown_sender", null, null, { from });
    return { status: 403, body: { ok: false, error: "unknown_sender" }, reply: null };
  }
  await audit("message.received", user.tenantId, user._id, { text, messageId });

  const intent = parseIntent(text);
  if (intent.kind === "unknown") {
    await audit("intent.unknown", user.tenantId, user._id, { text });
    const reply = 'Sorry, I didn\'t get that. Try "nuggets are out", "nuggets are back" or "change price of nuggets to $1 higher".';
    return { status: 422, body: { ok: false, error: "unknown_intent", reply }, reply };
  }

  if (intent.kind === "approve" || intent.kind === "reject") {
    return handleApproval(user, intent.kind === "approve", text);
  }

  const authz = await authorize(user, intent.permission, restaurantId);
  if (!authz.ok) {
    await audit("action.denied", user.tenantId, user._id, { reason: authz.reason, permission: intent.permission });
    return { status: 403, body: { ok: false, error: authz.reason }, reply: "You don't have permission to do that." };
  }

  const { membership } = authz;
  const now = new Date();
  const idempotencyKey = messageId || randomUUID();
  const itemId = resolveItemId(intent.itemName);
  const skill =
    intent.kind === "change_price"
      ? "middleware.change_price"
      : intent.available
        ? "middleware.mark_item_available"
        : "middleware.mark_item_unavailable";
  const params: Record<string, unknown> =
    intent.kind === "change_price" ? { itemId, price: intent.price } : { itemId, available: intent.available };

  let actionRunId;
  try {
    const { insertedId } = await collections.actionRuns().insertOne({
      tenantId: user.tenantId,
      restaurantId: membership.restaurantId,
      userId: user._id,
      skill,
      params,
      status: "running",
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    actionRunId = insertedId;
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      const existing = await collections.actionRuns().findOne({ tenantId: user.tenantId, idempotencyKey });
      return { status: 200, body: { ok: true, duplicate: true, actionRunId: existing?._id, status: existing?.status }, reply: null };
    }
    throw err;
  }
  await audit("action_run.created", user.tenantId, user._id, { actionRunId, skill, ...params });

  const base = {
    runId: String(actionRunId),
    tenantId: user.tenantId,
    userId: user._id,
    permissions: membership.permissions,
    message: text,
  };

  if (intent.kind === "change_price") {
    // Price changes always need owner approval (browser-exec enforces it). Without an approvalId it only
    // reads the current price and returns NEEDS_APPROVAL, so we can quote "from $X to $Y" first.
    const quotePrice = "absolute" in intent.price ? intent.price.absolute : 499.99;
    const quote = await executeSkill({
      ...base,
      idempotencyKey: `quote:${idempotencyKey}`,
      skillId: skill,
      inputs: { itemId, newPrice: quotePrice },
    });
    const current = quote.before?.price;
    const name = quote.before?.name ?? intent.itemName;
    if (quote.status === "ALREADY_DONE") {
      await finish(actionRunId, user.tenantId, user._id, "verified", quote);
      return { status: 200, body: { ok: true, actionRunId, status: "verified" }, reply: `${name} is already ${money(quotePrice)}.` };
    }
    if (quote.status !== "NEEDS_APPROVAL" || typeof current !== "number") {
      await finish(actionRunId, user.tenantId, user._id, "failed", quote);
      return { status: 200, body: { ok: false, actionRunId, status: "failed" }, reply: `Couldn't read the price of ${intent.itemName}: ${quote.message}` };
    }
    const newPrice = "absolute" in intent.price ? intent.price.absolute : Math.round((current + intent.price.delta) * 100) / 100;
    if (newPrice <= 0) {
      await finish(actionRunId, user.tenantId, user._id, "failed", quote);
      return { status: 200, body: { ok: false, actionRunId, status: "failed" }, reply: `That would make ${name} ${money(newPrice)}.` };
    }
    await collections.actionRuns().updateOne(
      { _id: actionRunId, tenantId: user.tenantId },
      { $set: { status: "awaiting_approval", params: { ...params, itemId, newPrice, oldPrice: current }, updatedAt: new Date() } },
    );
    await audit("action_run.awaiting_approval", user.tenantId, user._id, { actionRunId, oldPrice: current, newPrice });
    return {
      status: 202,
      body: { ok: true, actionRunId, status: "awaiting_approval", oldPrice: current, newPrice },
      reply: `Change ${name} from ${money(current)} to ${money(newPrice)}? Reply YES to confirm.`,
    };
  }

  const result = await executeSkill({ ...base, idempotencyKey: `exec:${idempotencyKey}`, skillId: skill, inputs: { itemId } });
  const status = isSuccess(result) ? "verified" : "failed";
  await finish(actionRunId, user.tenantId, user._id, status, result);
  const label = `${result.after?.name ?? intent.itemName} ${intent.available ? "available" : "out of stock"}`;
  const reply = status === "verified" ? `Done ✅ ${label}. ${result.message}` : `Couldn't confirm ${label}: ${result.message}`;
  return { status: 200, body: { ok: status === "verified", actionRunId, status, intent }, reply };
}

async function handleApproval(user: User, approved: boolean, text: string): Promise<Outcome> {
  const pending = await collections.actionRuns().findOne(
    { tenantId: user.tenantId, userId: user._id, status: "awaiting_approval", updatedAt: { $gte: new Date(Date.now() - APPROVAL_WINDOW_MS) } },
    { sort: { updatedAt: -1 } },
  );
  if (!pending) return { status: 200, body: { ok: false, error: "nothing_pending" }, reply: "There's nothing waiting for your approval." };

  // Claim it atomically so a double "YES" can't execute twice.
  const claimed = await collections.actionRuns().findOneAndUpdate(
    { _id: pending._id, tenantId: user.tenantId, status: "awaiting_approval" },
    { $set: { status: approved ? "running" : "denied", updatedAt: new Date() } },
  );
  if (!claimed) return { status: 200, body: { ok: false, error: "nothing_pending" }, reply: null };

  const { itemId, newPrice, oldPrice } = pending.params as { itemId: string; newPrice: number; oldPrice: number };
  if (!approved) {
    await audit("action_run.rejected", user.tenantId, user._id, { actionRunId: pending._id });
    return { status: 200, body: { ok: true, status: "denied" }, reply: "OK, cancelled. Price unchanged." };
  }
  await audit("action_run.approved", user.tenantId, user._id, { actionRunId: pending._id, newPrice });

  const membership = await collections.memberships().findOne({ tenantId: user.tenantId, userId: user._id, restaurantId: pending.restaurantId });
  const result = await executeSkill({
    runId: String(pending._id),
    idempotencyKey: `exec:${pending.idempotencyKey}`,
    tenantId: user.tenantId,
    userId: user._id,
    permissions: membership?.permissions ?? [],
    skillId: "middleware.change_price",
    inputs: { itemId, newPrice },
    approvalId: String(pending._id),
    message: text,
  });
  const status = isSuccess(result) ? "verified" : "failed";
  await finish(pending._id, user.tenantId, user._id, status, result);
  const name = result.after?.name ?? itemId;
  const reply =
    status === "verified"
      ? `Done ✅ ${name}: ${money(oldPrice)} → ${money(newPrice)}. ${result.message}`
      : `Couldn't confirm the price change for ${name}: ${result.message}`;
  return { status: 200, body: { ok: status === "verified", actionRunId: pending._id, status }, reply };
}

async function finish(actionRunId: ObjectId, tenantId: string, userId: string, status: ActionRunStatus, result: ExecuteResult) {
  await collections.actionRuns().updateOne(
    { _id: actionRunId, tenantId },
    { $set: { status, result: { ...result }, traceId: String(actionRunId), updatedAt: new Date() } },
  );
  await audit(`action_run.${status}`, tenantId, userId, { actionRunId, skillStatus: result.status, detail: result.message });
}

/** Channel-agnostic HTTP entry point. Body: { from, text, messageId?, restaurantId? } */
messagesRouter.post("/messages/inbound", async (req, res) => {
  const { from, text, messageId, restaurantId } = req.body ?? {};
  if (typeof from !== "string" || typeof text !== "string" || !from || !text) {
    return res.status(400).json({ ok: false, error: "from and text are required strings" });
  }
  const outcome = await handleInbound({ from, text, messageId, restaurantId });
  res.status(outcome.status).json(outcome.body);
});

/** BlueBubbles server webhook (API & Webhooks -> add webhook -> "New Messages"). */
messagesRouter.post("/webhooks/bluebubbles", async (req, res) => {
  const msg = parseWebhook(req.body);
  if (!msg) return res.json({ ok: true, ignored: true });
  // Ack immediately; BlueBubbles retries slow webhooks, and the skill can take a while.
  res.json({ ok: true });
  try {
    const outcome = await handleInbound({ from: msg.from, text: msg.text, messageId: msg.guid });
    if (outcome.reply) await sendText(msg.chatGuid, outcome.reply);
  } catch (err) {
    console.error("bluebubbles webhook failed", err);
  }
});
