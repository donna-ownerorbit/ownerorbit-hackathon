import type { Permission } from "../db/mongodb.js";

export type Intent =
  | { kind: "set_item_availability"; permission: Permission; itemName: string; available: boolean }
  | {
      kind: "change_price";
      permission: Permission;
      itemName: string;
      /** Either an absolute price or a delta from the current price. */
      price: { absolute: number } | { delta: number };
    }
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "unknown" };

const PRICE = String.raw`\$?\s*(\d+(?:\.\d{1,2})?)`;

/**
 * Deterministic parser for the demo phrasings. The LLM may replace this later, but identity,
 * permission and verification never depend on it.
 */
export function parseIntent(text: string): Intent {
  const t = text.trim().replace(/[.!]+$/, "");

  if (/^(yes|y|yep|yeah|approve|approved|confirm|do it|ok|okay)$/i.test(t)) return { kind: "approve" };
  if (/^(no|n|nope|cancel|stop|don'?t)$/i.test(t)) return { kind: "reject" };

  const priceTo = t.match(new RegExp(String.raw`^(?:change|set|update|make)\s+(?:the\s+)?price\s+(?:of|for)\s+(.+?)\s+to\s+${PRICE}$`, "i"))
    ?? t.match(new RegExp(String.raw`^(?:change|set|update|make)\s+(.+?)(?:'s)?\s+price\s+to\s+${PRICE}$`, "i"))
    ?? t.match(new RegExp(String.raw`^(?:change|set|update|make)\s+(.+?)\s+to\s+${PRICE}$`, "i"));
  if (priceTo) {
    return { kind: "change_price", permission: "pricing.write", itemName: priceTo[1], price: { absolute: Number(priceTo[2]) } };
  }

  // "change price of nuggets to $1 higher", "raise nuggets by $1", "nuggets $1 more", "lower nuggets by 50 cents"
  const rel =
    t.match(new RegExp(String.raw`^(?:change|set|update|make)\s+(?:the\s+)?price\s+(?:of|for)\s+(.+?)\s+(?:to\s+|by\s+)?${PRICE}\s+(higher|more|up|lower|less|down|cheaper)$`, "i")) ??
    t.match(new RegExp(String.raw`^(?:change|make)?\s*(.+?)\s+(?:to\s+|by\s+)?${PRICE}\s+(higher|more|up|lower|less|down|cheaper)$`, "i"));
  if (rel) {
    const sign = /lower|less|down|cheaper/i.test(rel[3]) ? -1 : 1;
    return { kind: "change_price", permission: "pricing.write", itemName: rel[1], price: { delta: sign * Number(rel[2]) } };
  }
  const raise = t.match(new RegExp(String.raw`^(raise|increase|bump|lower|decrease|drop|reduce)\s+(?:the\s+price\s+of\s+)?(.+?)\s+by\s+${PRICE}$`, "i"));
  if (raise) {
    const sign = /lower|decrease|drop|reduce/i.test(raise[1]) ? -1 : 1;
    return { kind: "change_price", permission: "pricing.write", itemName: raise[2], price: { delta: sign * Number(raise[3]) } };
  }

  const off = t.match(/^(?:mark|set|make)?\s*(.+?)\s+(?:as\s+|are\s+|is\s+)?(?:out of stock|unavailable|sold out|out|86(?:'?d)?)$/i);
  if (off) return { kind: "set_item_availability", permission: "menu.write", itemName: off[1], available: false };
  const on = t.match(/^(?:mark|set|make)?\s*(.+?)\s+(?:as\s+|are\s+|is\s+)?(?:back in stock|in stock|available|back)$/i);
  if (on) return { kind: "set_item_availability", permission: "menu.write", itemName: on[1], available: true };

  return { kind: "unknown" };
}
