import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// OrderDesk now persists to a backend (GET /api/state). readState must prefer it over the
// browser's stale localStorage copy — this is the bug that made "mark available" unverifiable.
test("readState prefers OrderDesk's backend over stale localStorage", async () => {
  const temp = await mkdtemp(join(tmpdir(), "api-state-"));
  const site = createServer((req, res) => {
    if (req.url?.startsWith("/api/state")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        restaurant: { storeId: "hayward", accepting: true, menuSyncedAt: 123 },
        categories: [], database: "ownerorbit",
        items: [{ id: "nuggets", name: "Chicken Nuggets with Fries", categoryId: "kids", price: 11.99, status: "available", stock: 1 }],
      }));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><script>localStorage.setItem("orderdesk:v1", JSON.stringify({storeId:"hayward",accepting:true,menuSyncedAt:1,categories:[],items:[{id:"nuggets",name:"Chicken Nuggets with Fries",categoryId:"kids",price:11.99,status:"sold_out_today",stock:1}]}));</script></body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  process.env.PW_PROFILE = join(temp, "profile");
  process.env.HEADLESS = "true";
  const { newPage, readState, closeBrowser } = await import("../src/tools/middlewareBrowser.js");
  try {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${(site.address() as { port: number }).port}/`);
    const s = await readState(page);
    assert.equal(s.items[0].status, "available", "should read the backend, not stale localStorage");
    assert.equal(s.menuSyncedAt, 123);
    assert.equal(s.storeId, "hayward");
  } finally {
    await closeBrowser();
    site.close();
    await rm(temp, { recursive: true, force: true });
  }
});
