import { chromium, type BrowserContext, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'
import type { Snapshot } from '../core/types.ts'
import { caption, installStage } from './stage.ts'

const LOCAL_KEY = 'orderdesk:v2'

/** Serialises work on the single browser page. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }
}

export interface SessionOptions {
  url?: string
  api?: 'live' | 'isolated' | 'auto'
  headless?: boolean
  profileDir?: string
  /** Visible browser, slowed down, with captions + click highlights for a live audience. */
  stage?: boolean
}

/**
 * One long-lived, logged-in browser on the sandbox. Persistent profile, so a sandbox running in
 * local mode keeps its state across restarts exactly like a human's browser would.
 */
export class SandboxSession {
  readonly url: string
  private ctx?: BrowserContext
  private _page?: Page
  private starting?: Promise<void>
  private lock = new Mutex()
  apiMode: 'live' | 'isolated' = 'live'

  constructor(private opts: SessionOptions = {}) {
    this.url = (opts.url ?? config.sandboxUrl).replace(/\/$/, '')
  }

  get stage() { return this.opts.stage ?? process.env.STAGE === '1' }

  /** Caption bar (stage mode only). */
  async say(msg: string, step: string, state: '' | 'ok' | 'fail' = '') {
    if (this.stage && this._page) await caption(this._page, msg, step, state)
  }

  get page(): Page {
    if (!this._page) throw new Error('session not started')
    return this._page
  }

  async start() {
    if (this._page) return
    this.starting ??= this.boot()
    await this.starting
  }

  private async boot() {
    const want = this.opts.api ?? config.sandboxApi
    this.apiMode = want === 'auto' ? ((await this.probeApi()) ? 'live' : 'isolated') : want
    const profile = this.opts.profileDir ?? config.profileDir
    mkdirSync(profile, { recursive: true })
    this.ctx = await chromium.launchPersistentContext(profile, {
      headless: this.stage ? false : this.opts.headless ?? config.headless,
      slowMo: this.stage ? 140 : 0,
      args: this.stage ? ['--window-size=1440,980'] : [],
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    this.ctx.setDefaultTimeout(10_000)
    if (this.stage) await installStage(this.ctx)
    if (this.apiMode === 'isolated') {
      // Database is down (or isolation was requested): fail /api fast so the app drops to its local store
      // immediately instead of waiting out an 8s server-selection timeout on every load.
      await this.ctx.route('**/api/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"isolated by ownerorbit"}' }))
    }
    this._page = this.ctx.pages()[0] ?? (await this.ctx.newPage())
    await this.load('/menu/overview')
  }

  private async probeApi(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(12_000) })
      return res.ok
    } catch { return false }
  }

  async close() {
    await this.ctx?.close()
    this.ctx = undefined
    this._page = undefined
    this.starting = undefined
  }

  /** Exclusive access to the page for one skill run. */
  exclusive<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      await this.start()
      return fn(this.page)
    })
  }

  /** Full page load + wait until the app has decided where its data lives. */
  async load(path: string) {
    await this.page.goto(this.url + path, { waitUntil: 'domcontentloaded' })
    await this.waitReady()
  }

  async waitReady() {
    await this.page.locator('.sb-sync.db, .sb-sync.local').first().waitFor({ timeout: 30_000 })
  }

  async reload() {
    await this.page.reload({ waitUntil: 'domcontentloaded' })
    await this.waitReady()
  }

  /** Client-side navigation through the SPA router (no reload, keeps state, ~instant). */
  async go(pathWithQuery: string) {
    const page = this.page
    const current = new URL(page.url())
    if (current.origin !== new URL(this.url).origin) return this.load(pathWithQuery)
    if (current.pathname + current.search !== pathWithQuery) {
      await page.evaluate((p) => {
        window.history.pushState({}, '', p)
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
      }, pathWithQuery)
    }
    await page.waitForFunction((p) => location.pathname + location.search === p, pathWithQuery)
  }

  async mode(): Promise<'db' | 'local'> {
    const cls = (await this.page.locator('.sb-sync').getAttribute('class')) ?? ''
    return cls.includes(' db') ? 'db' : 'local'
  }

  /**
   * Ground truth. In db mode: the app's own /api/state (what every viewer sees).
   * In local mode: the app's persisted store in this browser profile.
   */
  async readTruth(): Promise<Snapshot> {
    const page = this.page
    const mode = await this.mode()
    if (mode === 'db') {
      const s = await page.evaluate(async () => {
        const r = await fetch('/api/state', { cache: 'no-store' })
        if (!r.ok) throw new Error('state ' + r.status)
        return r.json()
      })
      return { mode, readAt: Date.now(), restaurant: s.restaurant, categories: s.categories, items: s.items, modifierGroups: s.modifierGroups, orders: s.orders }
    }
    const raw = await page.waitForFunction((k) => localStorage.getItem(k), LOCAL_KEY, { timeout: 10_000 }).then((h) => h.jsonValue() as Promise<string>)
    const s = JSON.parse(raw)
    return {
      mode, readAt: Date.now(),
      restaurant: { storeId: s.storeId, accepting: s.accepting, pausedUntil: s.pausedUntil ?? null, menuSyncedAt: s.menuSyncedAt },
      categories: s.categories, items: s.items, modifierGroups: s.modifierGroups, orders: s.orders,
    }
  }

  /** Poll ground truth (no reload) until pred holds; returns the last snapshot either way. */
  async waitForTruth(pred: (s: Snapshot) => boolean, timeoutMs = 6000): Promise<Snapshot> {
    const end = Date.now() + timeoutMs
    let s = await this.readTruth()
    while (!pred(s) && Date.now() < end) {
      await this.page.waitForTimeout(150)
      s = await this.readTruth()
    }
    return s
  }

  /** Screenshot for evidence; never throws. */
  async shot(dir: string, name: string): Promise<string | null> {
    try {
      mkdirSync(dir, { recursive: true })
      const p = join(dir, `${name}.png`)
      await this.page.screenshot({ path: p })
      return p
    } catch { return null }
  }

  async startTrace() {
    try { await this.ctx?.tracing.start({ screenshots: true, snapshots: true }) } catch { /* already tracing */ }
  }

  async stopTrace(path: string) {
    try { await this.ctx?.tracing.stop({ path }); return path } catch { return null }
  }
}
