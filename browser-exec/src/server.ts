import express from "express";
import { execute } from "./executor.js";
import { closeTracing } from "./trace.js";
import { registry } from "./skills/menuSkills.js";
import { confirmAcrossProviders } from "./confirmation/confirm.js";
import { newPage, findItem, gotoMenu, withBrowserLock } from "./tools/middlewareBrowser.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The harness calls POST /execute after auth + RBAC + (if needed) approval.
// Or skip HTTP and import { execute } directly if you're in the same repo.
export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, skills: Object.keys(registry) }));

app.post("/execute", async (req, res) => {
  try {
    res.json(await execute(req.body));
  } catch (e) {
    res.status(500).json({ status: "FAILED", message: String(e) });
  }
});

// Standalone confirmation check (e.g. owner asks "is the menu consistent everywhere?").
// body: { itemId, expected: { available?, price? }, autoPush?: boolean }
app.post("/confirm", async (req, res) => {
  const parsed = z.object({
    itemId: z.string().trim().min(1),
    expected: z.object({ available: z.boolean().optional(), price: z.number().finite().positive().optional() }).optional(),
    autoPush: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: "FAILED", message: `Bad inputs: ${parsed.error.message}` });
    return;
  }
  try {
    const result = await withBrowserLock(async () => {
      const page = await newPage();
      try {
        await gotoMenu(page);
        const item = await findItem(page, parsed.data.itemId);
        const cur = { available: item.status === "available", price: item.price };
        return await confirmAcrossProviders(
          page,
          // No observed provider snapshot exists in this mock. Only a new push
          // proves freshness for a standalone check; do not fabricate a baseline.
          { itemId: item.id, name: item.name, before: null, current: cur, changedAt: Date.now() },
          { ...cur, ...parsed.data.expected },
          { autoPush: parsed.data.autoPush ?? false },
        );
      } finally { await page.close().catch(() => {}); }
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: "FAILED", message: String(e) });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 4001);
  app.listen(port, () => console.log(`browser-exec on :${port}`));
  process.on("SIGINT", async () => { await closeTracing(); process.exit(0); });
}
