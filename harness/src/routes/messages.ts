import { randomUUID } from "node:crypto";
import { Router } from "express";
import { MongoServerError } from "mongodb";
import { authenticate } from "../auth/authenticate.js";
import { authorize } from "../auth/authorize.js";
import { parseIntent } from "../agent/intent.js";
import { audit } from "../audit/audit.js";
import { collections } from "../db/mongodb.js";
import { parseWebhook, sendText } from "../adapters/bluebubbles.js";
import { markItemAvailability, type SkillResult } from "../skills/markItemAvailability.js";

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

/** The single pipeline every channel uses: authenticate -> intent -> authorize -> action_run -> skill -> reply. */
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
    const reply = 'Sorry, I can only do menu availability right now, e.g. "Mark chicken nuggets out of stock."';
    return { status: 422, body: { ok: false, error: "unknown_intent", reply }, reply };
  }

  const authz = await authorize(user, intent.permission, restaurantId);
  if (!authz.ok) {
    await audit("action.denied", user.tenantId, user._id, { reason: authz.reason, permission: intent.permission });
    return { status: 403, body: { ok: false, error: authz.reason }, reply: "You don't have permission to do that." };
  }

  const { membership } = authz;
  const now = new Date();
  const idempotencyKey = messageId || randomUUID();
  const params = { itemName: intent.itemName, available: intent.available };
  let actionRunId;
  try {
    const { insertedId } = await collections.actionRuns().insertOne({
      tenantId: user.tenantId,
      restaurantId: membership.restaurantId,
      userId: user._id,
      skill: "markItemAvailability",
      params,
      status: "pending",
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
  await audit("action_run.created", user.tenantId, user._id, { actionRunId, ...params });

  const result: SkillResult = await markItemAvailability({
    ...params,
    runId: String(actionRunId),
    idempotencyKey,
    tenantId: user.tenantId,
    userId: user._id,
    permissions: membership.permissions,
    message: text,
  }).catch((err: Error) => ({ ok: false, verified: false, detail: `browser-exec unreachable: ${err.message}` }));

  const label = `${intent.itemName} ${intent.available ? "available" : "out of stock"}`;
  const status = result.ok && result.verified ? "verified" : "failed";
  await collections.actionRuns().updateOne(
    { _id: actionRunId, tenantId: user.tenantId },
    { $set: { status, result: { ...result }, traceId: result.traceId, updatedAt: new Date() } },
  );
  await audit(`action_run.${status}`, user.tenantId, user._id, { actionRunId, detail: result.detail });
  const reply =
    status === "verified"
      ? `Done ✅ ${label}. ${result.detail ?? "Verified."}`
      : `Couldn't confirm ${label}${result.detail ? `: ${result.detail}` : ""}.`;
  return { status: 200, body: { ok: status === "verified", actionRunId, status, intent }, reply };
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
