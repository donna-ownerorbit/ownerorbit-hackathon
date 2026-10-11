import { randomUUID } from "node:crypto";

export interface BlueBubblesMessage {
  guid: string;
  text: string;
  from: string;
  chatGuid: string;
}

/** Extract an inbound message from a BlueBubbles "new-message" webhook. Returns null for anything we should ignore. */
export function parseWebhook(body: any): BlueBubblesMessage | null {
  if (body?.type !== "new-message") return null;
  const d = body.data;
  if (!d || d.isFromMe || !d.text || !d.handle?.address) return null;
  return {
    guid: d.guid,
    text: d.text,
    from: d.handle.address,
    chatGuid: d.chats?.[0]?.guid ?? `iMessage;-;${d.handle.address}`,
  };
}

export async function sendText(chatGuid: string, message: string): Promise<void> {
  const url = process.env.BLUEBUBBLES_URL;
  const password = process.env.BLUEBUBBLES_PASSWORD;
  if (!url || !password) {
    console.warn("BLUEBUBBLES_URL/BLUEBUBBLES_PASSWORD not set; reply not sent:", message);
    return;
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/message/text?password=${encodeURIComponent(password)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatGuid, tempGuid: randomUUID(), message, method: "apple-script" }),
  });
  if (!res.ok) console.error("BlueBubbles send failed", res.status, await res.text());
}
