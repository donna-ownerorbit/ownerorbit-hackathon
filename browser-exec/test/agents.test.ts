import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecuteRequest } from "../src/skills/types.js";

// Real Playwright against a local version of the mock's UI/state contract.
// This never touches the live demo profile or external provider sites.
test("execution and confirmation agents", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "browser-exec-test-"));
  let disconnected = false;
  let uiMismatch = false;
  let coldStartup = false;
  let clicks = 0;
  const site = createServer((req, res) => {
    if (req.url === "/clicked") { clicks++; res.end("ok"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><body><main></main><script>
      const seed = {storeId:'hayward',items:[{id:'nuggets',name:'Chicken Nuggets with Fries',categoryId:'kids',price:11.99,status:'available',stock:10}],categories:[],menuSyncedAt:0,accepting:true};
      let s = JSON.parse(localStorage.getItem('orderdesk:v1') || JSON.stringify(seed));
      let hydrated = !${coldStartup};
      const labels = {available:'Available',sold_out_today:'Sold out today',sold_out:'Sold out indefinitely',hidden:'Hidden'};
      const root = document.querySelector('main');
      function save() { localStorage.setItem('orderdesk:v1', JSON.stringify(s)); }
      function clicked() { fetch('/clicked'); }
      function push() { clicked(); s.menuSyncedAt = Date.now(); save(); }
      function render() {
        const i = hydrated ? s.items[0] : seed.items[0];
        if (location.pathname === '/providers') {
          root.innerHTML = ['DoorDash','Uber Eats','Grubhub'].map(n=>'<div class="provider-card">'+n+' '+(${disconnected} && n==='Uber Eats'?'Paused':'Connected · menu synced')+'</div>').join('');
        } else {
          root.innerHTML = '<div class="row"><span class="name">'+i.name+'</span> <span>$'+(${uiMismatch} ? 99 : i.price).toFixed(2)+'</span><button class="status-btn" title="'+labels[i.status]+'">Status</button></div><div class="options"></div><div class="editor"></div><button class="push">Update provider menus</button>';
          document.querySelector('.push').onclick = push;
          document.querySelector('.status-btn').onclick = () => {
            document.querySelector('.options').innerHTML = Object.entries(labels).map(([k,v])=>'<button class="menu-item" data-key="'+k+'">'+v+'</button>').join('');
            document.querySelectorAll('.menu-item').forEach(b=>b.onclick=()=>{clicked();i.status=b.dataset.key;save();render();});
          };
          document.querySelector('.name').onclick = () => {
            document.querySelector('.editor').innerHTML='<div class="tf"><label class="tf-label">Price</label><input value="'+i.price+'"></div><button class="update">Update</button>';
            document.querySelector('.update').onclick=()=>{clicked();i.price=Number(document.querySelector('input').value);save();render();};
          };
        }
      }
      save(); render();
      if (!hydrated) setTimeout(()=>{hydrated=true;render();},250);
    </script></body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const address = site.address() as { port: number };
  process.env.MIDDLEWARE_URL = `http://127.0.0.1:${address.port}`;
  process.env.PW_PROFILE = join(temp, "profile");
  process.env.HEADLESS = "true";
  process.env.MONGODB_URI = "";
  const { execute } = await import("../src/executor.js");
  const { registry } = await import("../src/skills/menuSkills.js");
  const { closeBrowser, getContext, newPage, gotoMenu, findItem } = await import("../src/tools/middlewareBrowser.js");
  const { app } = await import("../src/server.js");
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => api.once("listening", r));
  const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  let n = 0;
  const request = (skillId = "middleware.mark_item_unavailable", inputs: Record<string, unknown> = { itemId: "nuggets" }): ExecuteRequest => ({
    runId: `run-${++n}`, idempotencyKey: `key-${n}`, tenantId: "test",
    actor: { userId: "owner", role: "OWNER", permissions: ["menu.write", "pricing.write"] }, skillId, inputs,
  });
  try {
    await t.test("permission, malformed request and invalid inputs never open the browser", async () => {
      const denied = request(); denied.actor.permissions = [];
      assert.equal((await execute(denied)).status, "FAILED");
      assert.equal((await execute({} as ExecuteRequest)).status, "FAILED");
      assert.equal((await execute(request("missing"))).status, "FAILED");
      assert.equal((await execute(request("__proto__"))).status, "FAILED");
      assert.equal((await execute(request(undefined, { itemId: "" }))).status, "FAILED");
      assert.equal((await execute(request("middleware.change_price", { itemId: "nuggets", newPrice: 12.345 }))).status, "FAILED");
      await assert.rejects(access(process.env.PW_PROFILE!));
    });
    await t.test("concurrent startup opens exactly one persistent context", async () => {
      const [a, b] = await Promise.all([getContext(), getContext()]);
      assert.equal(a, b);
    });
    await t.test("change verifies persisted state and UI, pushes stale providers once", async () => {
      const r = await execute(request());
      assert.equal(r.status, "VERIFIED");
      assert.equal(r.confirmation?.status, "CONSISTENT");
      assert.equal(r.confirmation?.pushed, true);
      assert.equal(r.confirmation?.checks.length, 3);
      assert.equal(r.attempts, 1);
      assert.ok(r.evidence.length >= 3);
    });
    await t.test("already-done does not click; repeated key returns identical result", async () => {
      const q = request(); const start = clicks;
      const r = await execute(q);
      assert.equal(r.status, "ALREADY_DONE");
      assert.deepEqual(await execute(q), r);
      assert.equal(clicks, start);
    });
    await t.test("seed UI during hydration settles before an already-done decision", async () => {
      coldStartup = true;
      const start = clicks;
      try {
        const r = await execute(request());
        assert.equal(r.status, "ALREADY_DONE");
        assert.equal(r.attempts, 0);
        assert.equal(clicks, start);
      } finally { coldStartup = false; }
    });
    await t.test("unapproved price is unchanged; approved price and rollback verify", async () => {
      const q = request("middleware.change_price", { itemId: "nuggets", newPrice: 12.49 });
      const start = clicks;
      const denied = await execute(q);
      assert.equal(denied.status, "NEEDS_APPROVAL");
      assert.equal(clicks, start);
      const page = await newPage();
      try { await gotoMenu(page); assert.equal((await findItem(page, "nuggets")).price, 11.99); }
      finally { await page.close(); }
      const approved = { ...request(q.skillId, q.inputs), approvalId: "approved-upstream" };
      assert.equal((await execute(approved)).status, "VERIFIED");
      assert.equal((await execute(request("middleware.mark_item_available"))).status, "VERIFIED");
    });
    await t.test("explicit provider push verifies an increased timestamp", async () => {
      assert.equal((await execute(request("middleware.push_provider_menus", {}))).status, "VERIFIED");
    });
    await t.test("duplicate in-flight validation cannot overwrite the original run", async () => {
      const q = request();
      const first = execute(q);
      const duplicate = await execute({ ...q, actor: { ...q.actor, permissions: [] } });
      assert.equal(duplicate.status, "FAILED");
      assert.match(duplicate.message, /already in progress/);
      const r = await first;
      assert.equal(r.status, "VERIFIED");
      assert.deepEqual(await execute(q), r);
    });
    await t.test("missing item needs human attention with evidence", async () => {
      const r = await execute(request(undefined, { itemId: "missing" }));
      assert.equal(r.status, "NEEDS_HUMAN");
      assert.ok(r.evidence.length);
    });
    await t.test("UI disagreement exhausts retries without claiming success", async () => {
      uiMismatch = true;
      const r = await execute(request("middleware.mark_item_available"));
      assert.equal(r.status, "NEEDS_HUMAN");
      assert.equal(r.attempts, 2);
      assert.ok(r.evidence.length);
      uiMismatch = false;
    });
    await t.test("verification read failure retries and closes every verification page", async () => {
      const base = registry["middleware.mark_item_available"];
      let reads = 0;
      registry["test.transient"] = { ...base, id: "test.transient", isDone: (_s, _i, before) => !!before,
        read: async (p, i) => { if (++reads === 2) throw new Error("transient read failure"); return base.read(p, i); } };
      const beforePages = (await getContext()).pages().length;
      const r = await execute(request("test.transient"));
      assert.equal(r.status, "VERIFIED");
      assert.equal(r.attempts, 2);
      assert.equal((await getContext()).pages().length, beforePages);
      delete registry["test.transient"];
    });
    await t.test("disconnected provider is named without a Done message", async () => {
      disconnected = true;
      const r = await execute(request("middleware.mark_item_sold_out"));
      assert.equal(r.status, "VERIFIED");
      assert.equal(r.confirmation?.status, "INCONSISTENT");
      assert.match(r.message, /Uber Eats/);
      assert.ok(!r.message.startsWith("Done"));
      disconnected = false;
    });
    await t.test("health and standalone confirmation validate and avoid fabricated freshness", async () => {
      assert.ok((await (await fetch(`${apiUrl}/health`)).json()).skills.includes("middleware.push_provider_menus"));
      const post = (body: unknown) => fetch(`${apiUrl}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal((await post({ itemId: "nuggets", autoPush: "false" })).status, 400);
      assert.equal((await (await post({ itemId: "nuggets" })).json()).status, "INCONSISTENT");
      const r = await (await post({ itemId: "nuggets", autoPush: true })).json();
      assert.equal(r.status, "CONSISTENT");
      assert.equal(r.pushed, true);
    });
    await t.test("broken status selector exhausts retries with screenshots", async () => {
      const { sel } = await import("../src/tools/selectors.js");
      const original = sel.statusOption;
      sel.statusOption = (p) => p.locator("button.deliberately-broken-selector");
      (await getContext()).setDefaultTimeout(150);
      try {
        const r = await execute(request("middleware.mark_item_available"));
        assert.equal(r.status, "NEEDS_HUMAN");
        assert.equal(r.attempts, 2);
        assert.ok(r.evidence.some((e) => e.includes("error-")));
      } finally {
        sel.statusOption = original;
        (await getContext()).setDefaultTimeout(30_000);
      }
    });
    await t.test("provider read and push failures remain named confirmation failures", async () => {
      const { PROVIDERS } = await import("../src/confirmation/providers.js");
      const { pushProviderMenus } = await import("../src/skills/menuSkills.js");
      const { confirmAcrossProviders } = await import("../src/confirmation/confirm.js");
      const adapter = PROVIDERS[1];
      const read = adapter.read;
      const push = pushProviderMenus.execute;
      adapter.read = async () => { throw new Error("provider read failed"); };
      pushProviderMenus.execute = async () => { throw new Error("push failed"); };
      const page = await newPage();
      try {
        const r = await confirmAcrossProviders(page, {
          itemId: "nuggets", name: "Chicken Nuggets with Fries", before: null,
          current: { available: false, price: 12.49 }, changedAt: Date.now(),
        }, { available: false, price: 12.49 });
        assert.equal(r.status, "INCONSISTENT");
        assert.equal(r.pushed, false);
        assert.equal(r.checks[1].provider, "Uber Eats");
        assert.match(r.checks[1].note, /provider read failed/);
        assert.match(r.checks[1].note, /push failed/);
      } finally {
        adapter.read = read;
        pushProviderMenus.execute = push;
        await page.close();
      }
    });
    await t.test("browser launch failure produces a stored terminal result", async () => {
      await closeBrowser();
      process.env.PW_PROFILE = "/dev/null/browser-exec";
      const q = request();
      const r = await execute(q);
      assert.equal(r.status, "FAILED");
      assert.deepEqual(await execute(q), r);
    });
  } finally {
    await closeBrowser();
    await new Promise<void>((r, reject) => api.close((e) => e ? reject(e) : r()));
    await new Promise<void>((r, reject) => site.close((e) => e ? reject(e) : r()));
    await rm(temp, { recursive: true, force: true });
  }
});
