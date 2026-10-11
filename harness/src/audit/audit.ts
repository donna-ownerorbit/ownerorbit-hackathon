import { collections } from "../db/mongodb.js";

export async function audit(
  type: string,
  tenantId: string | null,
  actorUserId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await collections.auditEvents().insertOne({ type, tenantId, actorUserId, data, at: new Date() });
}
