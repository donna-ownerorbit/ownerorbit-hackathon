// Standalone test without the rest of the system:
//   npx tsx src/try.ts middleware.mark_item_unavailable kids-chicken-nuggets-with-fries
//   npx tsx src/try.ts middleware.mark_item_available kids-chicken-nuggets-with-fries
//   npx tsx src/try.ts middleware.change_price kids-chicken-nuggets-with-fries 12.49 approved
//   npx tsx src/try.ts middleware.push_provider_menus
import { execute } from "./executor.js";
import { closeBrowser } from "./tools/middlewareBrowser.js";
import { closeTracing } from "./trace.js";

const [skillId, itemId, price, approved] = process.argv.slice(2);
const inputs: Record<string, unknown> = itemId ? { itemId } : {};
if (price) inputs.newPrice = Number(price);

const result = await execute({
  runId: `try-${Date.now()}`,
  idempotencyKey: `try-${skillId}-${itemId}-${price ?? ""}-${Date.now()}`,
  tenantId: "test-restaurant",
  actor: { userId: "abdullah", role: "OWNER", permissions: ["menu.write", "pricing.write"] },
  skillId,
  inputs,
  approvalId: approved ? "manual-test" : undefined,
  message: process.env.MSG, // e.g. MSG="nuggets are out" shows the owner text in Raindrop
});
console.log(JSON.stringify(result, null, 2));
await closeTracing();
await closeBrowser();
process.exit(0);
