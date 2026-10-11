import type { Permission } from "../db/mongodb.js";

export type Intent =
  | {
      kind: "set_item_availability";
      permission: Permission;
      itemName: string;
      available: boolean;
    }
  | { kind: "unknown" };

/**
 * Phase 1 placeholder: a deterministic regex parser so the permission pipeline can be tested.
 * Phase 2 replaces this with LLM-based normalization (aliases like "nugs" -> "Chicken Nuggets").
 */
export function parseIntent(text: string): Intent {
  const t = text.trim().replace(/[.!]+$/, "");
  const off = t.match(/^(?:mark|set|make)?\s*(.+?)\s+(?:as\s+)?(?:out of stock|unavailable|sold out|86(?:'?d)?)$/i);
  if (off) {
    return { kind: "set_item_availability", permission: "menu.write", itemName: off[1], available: false };
  }
  const on = t.match(/^(?:mark|set|make)?\s*(.+?)\s+(?:as\s+)?(?:back in stock|in stock|available)$/i);
  if (on) {
    return { kind: "set_item_availability", permission: "menu.write", itemName: on[1], available: true };
  }
  return { kind: "unknown" };
}
