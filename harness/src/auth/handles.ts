/**
 * Normalize an iMessage sender handle so it matches what we store in users.handles.
 * Emails are lowercased; phone numbers become E.164 (US numbers assumed when 10 digits).
 */
export function normalizeHandle(raw: string): string {
  const handle = raw.trim();
  if (handle.includes("@")) return handle.toLowerCase();
  const digits = handle.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}
