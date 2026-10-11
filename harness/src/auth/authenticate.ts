import { collections, type User } from "../db/mongodb.js";
import { normalizeHandle } from "./handles.js";

/** Deterministically map a sender handle to an active user. Returns null for unknown senders. */
export async function authenticate(senderHandle: string): Promise<User | null> {
  const handle = normalizeHandle(senderHandle);
  return collections.users().findOne({ handles: handle, status: "active" });
}
