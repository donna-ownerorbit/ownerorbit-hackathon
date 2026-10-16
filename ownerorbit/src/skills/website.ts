import { z } from 'zod'
import { SkillError, type Skill } from '../core/types.ts'
import { check, verdict } from './common.ts'

const def = <I extends Record<string, unknown>>(s: Skill<I>) => s as unknown as Skill

/* 30 ─────────────────────────────── website pages (API first; verified by loading the live page) */
const Publish = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/).describe('URL slug, e.g. "catering" → /p/catering'),
  title: z.string().max(120).optional().describe('Required for a new page'),
  headline: z.string().max(200).optional().describe('One-line promise under the title. Required for a new page'),
  intro: z.string().max(2000).optional(),
  highlights: z.array(z.string().max(160)).max(12).optional().describe('Short selling points, e.g. "Feeds 10–100", "24h notice"'),
  sections: z.array(z.object({ heading: z.string().max(120), body: z.string().max(3000) })).max(12).optional()
    .describe('Menu/packages, pricing, how ordering works, FAQ. Use only real menu items and prices'),
  cta: z.object({ label: z.string().max(60), href: z.string().max(500) }).optional().describe('e.g. { label: "Request a catering quote", href: "sms:+15105551234" }'),
  contact: z.string().max(300).optional(),
  published: z.boolean().optional().describe('false takes the page down (keeps history)'),
})
type PublishInput = z.infer<typeof Publish>

export const publishPage = def<PublishInput>({
  id: 'website.publish_page', title: 'Publish a website page',
  description: 'Create, update or unpublish a customer-facing page on the restaurant website (e.g. a corporate catering page at /p/catering). Every publish is a new version; verified by loading the live page.',
  domain: 'store', risk: 'write', minRole: 'owner', input: Publish,
  examples: ['make us a catering page', 'publish a corporate catering page', 'take the catering page down', 'update the catering page headline'],
  sessionOnly: true, // nothing in the menu snapshot changes; verify() does its own cold load of the public URL
  confirm: (i) => (i.published === false ? `Take /p/${i.slug} offline.` : `Publish "${i.title ?? i.slug}" at /p/${i.slug}.`),
  async run({ session, log }, i) {
    if (session.apiMode !== 'live') throw new SkillError('Publishing pages needs the live dashboard API (this run is isolated).')
    const res = await fetch(`${session.url}/api/pages/${i.slug}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...i, slug: undefined, updatedBy: 'donna', note: 'Published by Donna over iMessage' }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => ({}))) as { version?: number; error?: string; path?: string }
    if (!res.ok) throw new SkillError(`The website rejected the page: ${body.error ?? res.status}`)
    log(`published v${body.version}`)
    const url = `${session.url}/p/${i.slug}`
    return {
      summary: i.published === false ? `/p/${i.slug} is offline (v${body.version}).` : `"${i.title ?? i.slug}" is live at ${url} (v${body.version}).`,
      data: { version: body.version, url }, touched: 1,
    }
  },
  async verify({ session, output }, i) {
    const { version, url } = output.data as { version: number; url: string }
    // Fresh tab, cold load: exactly what a customer opening the link sees.
    const tab = await session.page.context().newPage()
    try {
      await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      const root = tab.locator('.pp[data-state="ready"], .pp[data-state="missing"]').first()
      await root.waitFor({ timeout: 15_000 })
      const state = await root.getAttribute('data-state')
      if (i.published === false) return verdict([check('page offline', 'missing', state)])
      const shown = Number(await root.getAttribute('data-version'))
      const title = (await tab.locator('h1.pp-title').textContent())?.trim() ?? ''
      const checks = [check('page renders', 'ready', state), check('live version', version, shown)]
      if (i.title) checks.push(check('title', i.title, title))
      return verdict(checks)
    } finally {
      await tab.close().catch(() => undefined)
    }
  },
  inverse: (i, _before, out) => {
    const v = (out.data as { version?: number } | undefined)?.version
    return v === 1 && i.published !== false ? [{ skill: 'website.publish_page', input: { slug: i.slug, published: false }, why: 'take the new page down' }] : null
  },
})

export const websiteSkills: Skill[] = [publishPage]
