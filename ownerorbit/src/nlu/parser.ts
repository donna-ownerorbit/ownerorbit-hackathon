import type { PlanStep, Snapshot, Status } from '../core/types.ts'
import { Catalog, type Entity, type EntityKind, type Match } from './resolver.ts'

/**
 * Deterministic grammar for owner texts. Fast (<5ms), offline, and predictable on stage.
 * Anything it can't parse falls through to the Claude planner (hybrid mode).
 */

export interface Focus { items?: string[]; category?: string; group?: string; order?: string; lastStep?: PlanStep }

export type Parse =
  | { kind: 'plan'; steps: PlanStep[]; confidence: number; notes?: string[] }
  | { kind: 'clarify'; question: string; options: { label: string; steps: PlanStep[] }[] }
  | { kind: 'ask'; question: string; step: PlanStep; field: string; type: 'number' | 'text' }
  | { kind: 'meta'; meta: 'help' | 'undo' | 'yes' | 'no' | 'history' | 'whoami' | 'skills' | 'choice'; value?: number }
  | { kind: 'unknown'; reason?: string }

type Clause = Parse | null

/* ─────────────────────────────── text utilities ─────────────────────────────── */
const WORDNUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, hundred: 100, half: 0.5, quarter: 0.25,
}
const NUM = String.raw`(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|half|a quarter|quarter)`

export function num(s: string): number | null {
  s = s.trim().toLowerCase().replace(/^a quarter$/, 'quarter')
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)
  return WORDNUM[s] ?? null
}

/** "$1", "1 dollar", "50 cents", "a buck", "10%", "ten percent" → {value, unit} */
export function amount(s: string): { value: number; unit: '$' | '%' } | null {
  const m = s.trim().toLowerCase().match(new RegExp(String.raw`^(\$)?\s*(${NUM})\s*(%|percent|pct|cents?|¢|dollars?|bucks?|bux)?$`))
  if (!m) return null
  const n = num(m[2])
  if (n === null) return null
  if (m[3] && /^(%|percent|pct)$/.test(m[3])) return { value: n, unit: '%' }
  if (m[3] && /^(cents?|¢)$/.test(m[3])) return { value: n / 100, unit: '$' }
  if (!m[1] && !m[3] && !/\./.test(m[2]) && n >= 1 && n <= 100 && !/^\d+$/.test(m[2])) return { value: n, unit: '$' }
  return { value: n, unit: '$' }
}

const PRICE_RX = /\$\s?(\d+(?:\.\d{1,2})?)|\b(\d+\.\d{2})\b|\b(\d+(?:\.\d{1,2})?)\s*(?:dollars|bucks)\b/i
function priceIn(s: string): { value: number; at: number; len: number } | null {
  const m = s.match(PRICE_RX)
  if (!m || m.index === undefined) return null
  return { value: parseFloat(m[1] ?? m[2] ?? m[3]), at: m.index, len: m[0].length }
}

function clean(raw: string) {
  return raw
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/^\s*(hey|hi|hello|yo|ok|okay|alright)\b[\s,!]*/i, '')
    .replace(/^\s*donna\b[\s,:!]*/i, '')
    .replace(/\b(please|pls|plz|kindly|real quick|asap|right now|for me|thanks|thank you|thx|ty)\b[\s,!.]*/gi, ' ')
    .replace(/^\s*(can|could|would|will) you\s+/i, '')
    .replace(/^\s*(i need you to|i want you to|i'd like you to|go ahead and|let's|lets|let us|we need to|we gotta|gotta|need to)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s?!]+$/g, '')
    .trim()
}

/** Open questions ('what time…', 'why…') need judgment, not a menu lookup. */
const OPEN_QUESTION = /^(what time|when|why|how come|how long|should|could|would|is it (ok|worth)|what do you think)\b/i
/** Words too common in item names to identify one item. */
const GENERIC = new Set(['with', 'fries', 'plate', 'platter', 'wrap', 'wraps', 'meal', 'kids', 'side', 'large', 'small', 'combo', 'sauce', 'special'])
const PRONOUN = /^(it|that|them|those|these|this|that one|this one|the same|same)$/i
const strip = (s: string) => s.replace(/^\s*(the|our|my|a|an)\s+/i, '').replace(/\s+(please|now|again|too|today|tonight|as well)$/i, '').trim()

/* ─────────────────────────────── the parser ─────────────────────────────── */
export class Parser {
  readonly cat: Catalog
  constructor(snap: Snapshot, private focus: Focus = {}) { this.cat = new Catalog(snap) }

  parse(text: string): Parse {
    const t = clean(text)
    if (!t) return { kind: 'unknown', reason: 'empty' }
    const meta = this.meta(t)
    if (meta) return meta

    // Clauses: sentences / ";" / newlines / "then" / "also"
    const clauses = t.split(/\s*(?:;|\n|(?<=[a-z0-9)])\.\s+|,?\s+and then\s+|,?\s+then\s+|,?\s+also\s+)\s*/i).map((c) => c.trim()).filter(Boolean)
    const steps: PlanStep[] = []
    const notes: string[] = []
    let conf = 1
    for (const c of clauses) {
      const r = this.clauseOrSplit(c)
      if (!r || r.kind === 'unknown') return clauses.length > 1 && steps.length ? { kind: 'unknown', reason: `couldn't parse "${c}"` } : r ?? { kind: 'unknown' }
      if (r.kind !== 'plan') return r // clarify / ask: resolve one thing at a time
      steps.push(...r.steps)
      notes.push(...(r.notes ?? []))
      conf = Math.min(conf, r.confidence)
    }
    // Coverage guard: a confident partial parse must never silently drop part of the request.
    const missed = this.uncoveredItems(t, steps)
    if (missed.length) { conf = Math.min(conf, 0.4); notes.push(`not handled by the grammar: ${missed.join(', ')}`) }
    if (OPEN_QUESTION.test(t) && steps.every((x) => x.skill === 'menu.lookup' || x.skill.startsWith('insights.'))) conf = Math.min(conf, 0.5)
    return { kind: 'plan', steps, confidence: conf, notes }
  }

  /** Menu items the text clearly names (by a word unique to that item) that no step refers to. */
  private uncoveredItems(text: string, steps: PlanStep[]): string[] {
    const items = this.cat.entities.filter((e) => e.kind === 'item')
    const freq = new Map<string, number>()
    const words = (n: string) => [...new Set(n.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !GENERIC.has(w)))]
    for (const i of items) for (const w of words(i.name)) freq.set(w, (freq.get(w) ?? 0) + 1)
    const said = new Set(text.toLowerCase().split(/[^a-z]+/))
    const planned = JSON.stringify(steps.map((x) => x.input)).toLowerCase()
    const stepCats = steps.map((x) => (x.input as { category?: string }).category).filter(Boolean)
    const out: string[] = []
    for (const i of items) {
      const hit = words(i.name).find((w) => freq.get(w) === 1 && (said.has(w) || said.has(w.replace(/s$/, ''))))
      if (!hit || planned.includes(hit) || planned.includes(i.name.toLowerCase())) continue
      if (stepCats.some((c) => this.cat.entities.find((e) => e.kind === 'category' && e.name === c)?.id === i.parentId)) continue
      out.push(i.name)
    }
    return out
  }

  /** Try the whole clause, then split at "and"/"," boundaries where both halves are commands. */
  private clauseOrSplit(c: string): Clause {
    const whole = this.clause(c)
    const parts = c.split(/\s*(?:,\s*and|,|\band\b)\s+/i)
    for (let k = 1; k < parts.length; k++) {
      const left = this.clause(parts.slice(0, k).join(' and '))
      const right = this.clauseOrSplit(parts.slice(k).join(' and '))
      if (left?.kind === 'plan' && right?.kind === 'plan' && !(whole?.kind === 'plan' && left.steps[0].skill === right.steps[0].skill)) {
        return { kind: 'plan', steps: [...left.steps, ...right.steps], confidence: Math.min(left.confidence, right.confidence), notes: [...(left.notes ?? []), ...(right.notes ?? [])] }
      }
    }
    return whole
  }

  private clause(c: string): Clause {
    const parsers = [
      this.hours, this.chargebacks, this.orderUpdate, this.ordersList, this.acceptance, this.location, this.publish,
      this.modifierGroup, this.itemModifiers, this.size, this.tax, this.inventory, this.description, this.duplicate,
      this.categoryCreate, this.reorder, this.rename, this.del, this.price, this.createItem, this.lookup, this.availability,
      this.sales, this.brief, this.followUp,
    ]
    let unknownReason: Clause = null
    for (const p of parsers) {
      const r = p.call(this, c)
      if (r && r.kind !== 'unknown') return r
      if (r) unknownReason = r
    }
    return unknownReason
  }

  /* ───────── meta ───────── */
  private meta(t: string): Parse | null {
    const s = t.toLowerCase().replace(/[.!]+$/, '')
    if (/^(help|\?|commands|what can you do|what do you do|how do (i|we) use (you|this)|options)$/.test(s)) return { kind: 'meta', meta: 'help' }
    if (/^(skills|list skills|capabilities)$/.test(s)) return { kind: 'meta', meta: 'skills' }
    if (/^(undo|undo (that|it|last|the last (one|change|thing))|revert( that| it)?|roll ?back( that)?|reverse that|take (that|it) back|put it back the way it was)$/.test(s)) return { kind: 'meta', meta: 'undo' }
    if (/^(y|ya|yes|yep|yeah|yup|yes please|confirm(ed)?|do it|go|go ahead|ok do it|sure|approve(d)?|send it|ship it|👍|✅|correct|affirmative)$/.test(s)) return { kind: 'meta', meta: 'yes' }
    if (/^(n|no|nope|nah|cancel|stop|nevermind|never mind|nvm|abort|don'?t|no thanks|forget it)$/.test(s)) return { kind: 'meta', meta: 'no' }
    if (/^(history|log|recent( changes)?|what did you (do|change)( today)?|last (action|change)s?)$/.test(s)) return { kind: 'meta', meta: 'history' }
    if (/^(who am i|whoami|my role)$/.test(s)) return { kind: 'meta', meta: 'whoami' }
    const ord: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 }
    const m = s.match(/^(?:option\s*|#)?([1-9])$/) ?? s.match(/^(?:the\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)(?:\s+one)?$/)
    if (m) return { kind: 'meta', meta: 'choice', value: ord[m[1]] ?? Number(m[1]) }
    return null
  }

  /* ───────── entity helpers ───────── */
  /** Resolve a list span ("the nuggets and wings") to entities, asking when ambiguous. */
  private resolveList(span: string, kinds: EntityKind[]): { ok: Entity[]; score: number } | { ambiguous: Match[]; span: string } | null {
    span = strip(span)
    if (!span) return null
    if (PRONOUN.test(span)) {
      if (kinds.includes('item') && this.focus.items?.length) return { ok: this.focus.items.map((n) => this.cat.entities.find((e) => e.kind === 'item' && e.name === n)!).filter(Boolean), score: 0.9 }
      if (kinds.includes('category') && this.focus.category) return { ok: [this.cat.entities.find((e) => e.kind === 'category' && e.name === this.focus.category)!], score: 0.9 }
      return null
    }
    const whole = this.cat.resolve(span, kinds)
    if (whole.kind === 'one' && whole.match.score === 1) return { ok: [whole.match.entity], score: 1 }
    const parts = span.split(/\s*(?:,\s*and\s+|,|\s+and\s+|\s*&\s*|\s+\+\s+|\s+plus\s+)\s*/i).map(strip).filter(Boolean)
    if (parts.length > 1 && parts.every((p) => this.cat.resolve(p, kinds).kind !== 'none')) {
      const out: Entity[] = []
      let score = 1
      for (const p of parts) {
        const r = this.cat.resolve(p, kinds)
        if (r.kind === 'none') return null
        if (r.kind === 'ambiguous') return { ambiguous: r.options, span: p }
        out.push(r.match.entity)
        score = Math.min(score, r.match.score)
      }
      return { ok: out, score }
    }
    if (whole.kind === 'one' && whole.match.score >= 0.6) return { ok: [whole.match.entity], score: whole.match.score }
    if (whole.kind === 'one') return { ok: [whole.match.entity], score: whole.match.score }
    if (whole.kind === 'ambiguous') return { ambiguous: whole.options, span }
    return null
  }

  private one(span: string, kinds: EntityKind[]): Entity | { ambiguous: Match[]; span: string } | null {
    const r = this.resolveList(span, kinds)
    if (!r) return null
    if ('ambiguous' in r) return r
    return r.ok.length === 1 ? r.ok[0] : null
  }

  private clarify(amb: { ambiguous: Match[]; span: string }, build: (e: Entity) => PlanStep, verb: string): Parse {
    return {
      kind: 'clarify',
      question: `Which "${amb.span}" ${verb}?`,
      options: amb.ambiguous.map((m) => ({ label: m.entity.name, steps: [build(m.entity)] })),
    }
  }

  /* ───────── availability ───────── */
  statusOf(s: string): Status | null {
    const l = s.toLowerCase()
    if (/\b(unhide|un-?86(?:'?d|ed)?|back in stock|(?:is|are|'s|'re) back|back on(?: the menu)?|bring (?:\w+ )*back|restock(?:ed)?|in stock again|available again)\b/.test(l)) return 'available'
    if (/\b(hide|hidden|unlist|delist|take (?:\w+ ){0,4}off (?:the )?menu|pull (?:\w+ ){0,4}(?:off|from) (?:the )?menu|remove (?:\w+ ){0,5}from (?:the )?menu)\b/.test(l)) return 'hidden'
    if (/\b(indefinitely|permanently|for good|until further notice|discontinu\w*|long[- ]term|for the (?:week|season))\b/.test(l)) return 'sold_out'
    if (/(^|\s)(86|eighty[- ]?six)(?:'?d|ed)?\b|\b(sold out|out of(?: stock)?|ran out|run out|running out|unavailable|not available|no more|(?:we'?re|we are|all) out|disable|turn (?:\w+ ){0,4}off|pause|mark (?:\w+ ){0,5}(?:as )?out|out(?: for (?:today|tonight|the day))?$)/.test(l)) return 'sold_out_today'
    if (/\b(available|in stock|enable|turn (?:\w+ ){0,4}on|re-?list|show)\b/.test(l)) return 'available'
    return null
  }

  private availability(c: string): Clause {
    const status = this.statusOf(c)
    if (!status) return null
    if (/\b(orders?|ordering|accepting|kitchen|store|restaurant|deliver(?:y|ies))\b/i.test(c) && !/\bmenu\b/i.test(c)) return null
    const providers = (c.match(/\bon\s+((?:doordash|door dash|uber ?eats|uber|grubhub|grub hub|(?:the )?website)(?:\s*(?:,|and|&)\s*(?:doordash|door dash|uber ?eats|uber|grubhub|grub hub|(?:the )?website))*)\b/i)?.[1] ?? '')
      .split(/\s*(?:,|and|&)\s*/).filter(Boolean).map((p) => (/door/i.test(p) ? 'DoorDash' : /uber/i.test(p) ? 'Uber Eats' : /grub/i.test(p) ? 'Grubhub' : 'Website'))
    let span = c
      .replace(/\bon\s+(?:doordash|door dash|uber ?eats|uber|grubhub|grub hub|(?:the )?website)(?:\s*(?:,|and|&)\s*(?:doordash|door dash|uber ?eats|uber|grubhub|grub hub|(?:the )?website))*/gi, ' ')
      .replace(/\b(?:on all (?:the )?(?:providers|platforms|apps)|everywhere|across the board)\b/gi, ' ')
      .replace(/(^|\s)(?:86|eighty[- ]?six)(?:'?d|ed)?(?=\s|$)/gi, ' ')
      .replace(/\b(?:un-?86(?:'?d|ed)?|unhide|hide|hidden|unlist|delist|sold out|out of stock|out of|ran out of|run out of|running out of|running low on|unavailable|not available|available|in stock|back in stock|no more|we'?re out of|we are out of|we'?re all out of|all out of|we'?re out|disable|enable|restock(?:ed)?|re-?list|show)\b/gi, ' ')
      .replace(/\b(?:indefinitely|permanently|for good|until further notice|discontinue[ds]?|long[- ]term|for the (?:week|season|day|night)|for (?:today|tonight)|today|tonight|until tomorrow|again|now|right now|for now|anymore|any more)\b/gi, ' ')
      .replace(/\b(?:take|pull|remove)\b(.*?)\b(?:off|from)\s+(?:the\s+)?menu\b/gi, '$1')
      .replace(/\b(?:turn|switch)\b(.*?)\b(?:off|on|back on)\b/gi, '$1')
      .replace(/\b(?:bring)\b(.*?)\bback\b/gi, '$1')
      .replace(/\b(?:is|are|'s|'re)\s+back\b/gi, ' ')
      .replace(/\b(?:back on(?: the menu)?|back)\b/gi, ' ')
      .replace(/\b(?:mark|set|make|put|get|have|has|we(?:'re| are| have| got)?|i|they|is|are|was|were|it's|its|as|to|be|status(?: of)?|item|items|menu|please|the|pause|completely|totally|just|all of|all the|the whole|whole)\b/gi, ' ')
      .replace(/[,.:!]+$/g, '')
      .replace(/\s+/g, ' ').trim()
    // "everything in kids meal", "all burgers", "the whole kids menu"
    let category: string | undefined
    const everything = /^(?:everything|every(?:thing| item)?|all|entire)\s*(?:in|from|on|under|of)?\s*(.*)$/i.exec(span)
    if (everything) span = everything[1].trim() || span
    const wantsCategory = /\b(category|section)\b/i.test(c)
    if (wantsCategory) {
      const cat = this.one(span.replace(/\b(category|section)\b/gi, '').trim(), ['category'])
      if (cat && 'ambiguous' in cat) return this.clarify(cat, (e) => ({ skill: 'menu.category.set_status', input: { category: e.name, status } }), 'category')
      if (cat) return { kind: 'plan', steps: [{ skill: 'menu.category.set_status', input: { category: cat.name, status } }], confidence: 0.92 }
      return null
    }
    if (!span) return null
    const r = this.resolveList(span, ['item', 'category'])
    if (!r) return { kind: 'unknown', reason: `no menu item matches "${span}"` }
    if ('ambiguous' in r) {
      return this.clarify(r, (e) => ({ skill: 'menu.item.set_availability', input: e.kind === 'category' ? { category: e.name, status } : { items: [e.name], status } }), 'did you mean')
    }
    const items = r.ok.filter((e) => e.kind === 'item').map((e) => e.name)
    const cats = r.ok.filter((e) => e.kind === 'category')
    if (cats.length > 1) return null
    category = cats[0]?.name
    const input: Record<string, unknown> = { status }
    if (items.length) input.items = items
    if (category) input.category = category
    if (providers.length && items.length === 1 && !category) input.providers = providers
    const notes = /\bremove\b/i.test(c) && status === 'hidden' ? ['Hid it (reversible). Say "delete …" to remove permanently.'] : []
    return { kind: 'plan', steps: [{ skill: 'menu.item.set_availability', input }], confidence: r.score, notes }
  }

  /* ───────── prices ───────── */
  private price(c: string): Clause {
    // relative: raise/lower X by N(%|$)
    const rel = c.match(new RegExp(String.raw`^(raise|increase|bump(?: up)?|hike|up|mark up|lower|drop|decrease|cut|reduce|discount|knock(?: down)?|mark down)\s+(?:the\s+)?(?:prices?\s+(?:of|on|for)\s+)?(.+?)(?:\s+prices?)?\s+(?:by\s+)?((?:\$\s?)?${NUM}\s*(?:%|percent|pct|cents?|¢|dollars?|bucks?)?)(?:\s+(?:and\s+)?(?:round(?:ed)?\s+)?(?:to\s+)?(?:\.99|99|nines?|ending in \.?99))?$`, 'i'))
      ?? c.match(new RegExp(String.raw`^(add)\s+((?:\$\s?)?${NUM}\s*(?:%|percent|cents?|¢|dollars?|bucks?)?)\s+to\s+(?:the\s+)?(?:price\s+of\s+)?(.+?)(?:\s+prices?)?$`, 'i'))
    if (rel) {
      const isAdd = rel[1].toLowerCase() === 'add'
      const amt = amount(isAdd ? rel[2] : rel[3])
      const spanRaw = isAdd ? rel[3] : rel[2]
      if (!amt) return null
      const sign = /^(lower|drop|decrease|cut|reduce|discount|knock|mark down)/i.test(rel[1]) ? -1 : 1
      const nines = /\.99|nines?|99\b/.test(c)
      return this.priceTargets(spanRaw, (items, category, single) =>
        single && !nines
          ? { skill: 'menu.item.set_price', input: { item: single, ...(amt.unit === '%' ? { percent: sign * amt.value } : { delta: sign * amt.value }) } }
          : { skill: 'menu.items.adjust_prices', input: { ...(items ? { items } : {}), ...(category ? { category } : {}), ...(amt.unit === '%' ? { percent: sign * amt.value } : { amount: sign * amt.value }), rounding: nines ? 'nines' : 'cents' } })
    }
    // absolute: "change flame burger to $17.99", "falafel wrap is 11.49 now", "price of X = 9"
    const p = priceIn(c)
    const abs = c.match(/^(?:change|set|make|update|put|price)?\s*(?:the\s+)?(?:price\s+(?:of|for|on)\s+)?(.+?)(?:'s)?(?:\s+price)?\s*(?:to|=|at|is now|should be|now costs?|costs?|now|is|for)\s*\$?\s?(\d+(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks))?(?:\s+now)?$/i)
    if (abs && (p || /\bprice\b/i.test(c))) {
      const value = parseFloat(abs[2])
      return this.priceTargets(abs[1], (_items, _cat, single) => (single ? { skill: 'menu.item.set_price', input: { item: single, price: value } } : null))
    }
    return null
  }

  private priceTargets(spanRaw: string, build: (items: string[] | undefined, category: string | undefined, single: string | undefined) => PlanStep | null): Clause {
    let span = strip(spanRaw).replace(/\b(prices?|the price of|items?)\b/gi, '').trim()
    if (/^(?:all|every(?:thing)?|the (?:whole|entire) menu|menu|all (?:menu )?prices)$/i.test(span) || !span) {
      const step = build(this.cat.snap.items.map((i) => i.name), undefined, undefined)
      return step ? { kind: 'plan', steps: [step], confidence: 0.85 } : null
    }
    span = span.replace(/^(?:all|every|everything in|all the|all of the)\s+/i, '')
    const r = this.resolveList(span, ['item', 'category'])
    if (!r) return { kind: 'unknown', reason: `no menu item matches "${span}"` }
    if ('ambiguous' in r) return this.clarify(r, (e) => build(e.kind === 'item' ? [e.name] : undefined, e.kind === 'category' ? e.name : undefined, e.kind === 'item' ? e.name : undefined)!, 'did you mean')
    const items = r.ok.filter((e) => e.kind === 'item').map((e) => e.name)
    const cats = r.ok.filter((e) => e.kind === 'category').map((e) => e.name)
    if (cats.length > 1) return null
    const single = items.length === 1 && !cats.length ? items[0] : undefined
    const step = build(items.length ? items : undefined, cats[0], single)
    return step ? { kind: 'plan', steps: [step], confidence: r.score } : null
  }

  /* ───────── rename (item or category) ───────── */
  private rename(c: string): Clause {
    const m = c.match(/^(?:rename|change the name of|change)\s+(?:the\s+)?(.+?)\s+(?:to|as|into)\s+["']?(.+?)["']?$/i)
      ?? c.match(/^call\s+(?:the\s+)?(.+?)\s+(?:the\s+)?["']?(.+?)["']?\s+instead$/i)
    if (!m) return null
    if (/^change/i.test(c) && !/name/i.test(c) && !/^change the name/i.test(c)) return null
    const isCat = /\b(category|section)\b/i.test(m[1])
    const e = this.one(m[1].replace(/\b(category|section|name of)\b/gi, '').trim(), isCat ? ['category'] : ['item', 'category'])
    if (!e) return { kind: 'unknown', reason: `nothing called "${m[1]}"` }
    if ('ambiguous' in e) return this.clarify(e, (x) => (x.kind === 'category' ? { skill: 'menu.category.edit', input: { category: x.name, newName: titleCase(m[2]) } } : { skill: 'menu.item.rename', input: { item: x.name, newName: titleCase(m[2]) } }), 'should I rename')
    const newName = titleCase(m[2])
    return { kind: 'plan', steps: [e.kind === 'category' ? { skill: 'menu.category.edit', input: { category: e.name, newName } } : { skill: 'menu.item.rename', input: { item: e.name, newName } }], confidence: 0.92 }
  }

  /* ───────── description ───────── */
  private description(c: string): Clause {
    const gen = c.match(/^(?:write|generate|create|make|give(?: me)?|draft|redo|rewrite|improve|punch up|spice up|ai)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+|better\s+|fresh\s+|good\s+|catchy\s+|ai\s+)*description\s+(?:for|of|on)\s+(?:the\s+)?(.+)$/i)
      ?? c.match(/^(?:(?:re)?write|improve|punch up)\s+(?:the\s+)?(.+?)(?:'s)?\s+description$/i)
    const set = c.match(/^(?:set|change|update|make)\s+(?:the\s+)?(.+?)(?:'s)?\s+description\s+(?:to|:|=)\s*["']?(.+?)["']?$/i)
      ?? c.match(/^(?:set|change|update|make)\s+(?:the\s+)?description\s+(?:of|for|on)\s+(?:the\s+)?(.+?)\s+(?:to|:|=)\s*["']?(.+?)["']?$/i)
      ?? c.match(/^(.+?)\s+description\s*(?::|=|should be|should say)\s*["']?(.+?)["']?$/i)
    const m = gen ?? set
    if (!m) return null
    const isCat = /\b(category|section)\b/i.test(m[1])
    const e = this.one(m[1].replace(/\b(category|section)\b/gi, '').trim(), isCat ? ['category'] : ['item', 'category'])
    if (!e) return { kind: 'unknown', reason: `nothing called "${m[1]}"` }
    const mk = (x: Entity): PlanStep => x.kind === 'category'
      ? { skill: 'menu.category.edit', input: { category: x.name, description: set?.[2] ?? '' } }
      : { skill: 'menu.item.set_description', input: gen ? { item: x.name, generate: true } : { item: x.name, description: set![2] } }
    if ('ambiguous' in e) return this.clarify(e, mk, 'did you mean')
    if (e.kind === 'category' && gen) return null
    return { kind: 'plan', steps: [mk(e)], confidence: 0.9 }
  }

  /* ───────── create item ───────── */
  private createItem(c: string): Clause {
    if (!/^(?:add|create|new item|put|list)\b/i.test(c)) return null
    if (/\b(category|section|modifier|option|size|stock|inventory|tax)\b/i.test(c)) return null
    const p = priceIn(c) ?? (() => { const m = c.match(/\b(?:for|at|@)\s+(\d+(?:\.\d{1,2})?)\b/i); return m?.index !== undefined ? { value: parseFloat(m[1]), at: m.index, len: m[0].length } : null })()
    let rest = p ? (c.slice(0, p.at) + ' ' + c.slice(p.at + p.len)) : c
    rest = rest.replace(/\b(?:for|at|@)\s*$/i, '').replace(/\s+(?:for|at|@)\s+(?=(?:to|in|into|under)\b)/i, ' ').replace(/,\s*$/, '').replace(/\s+/g, ' ').trim()
    const m = rest.match(/^(?:add|create|put|list)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:item\s*:?\s*)?(?:called\s+|named\s+)?["']?(.+?)["']?\s+(?:to|in|into|under|on)\s+(?:the\s+)?(.+?)(?:\s+(?:category|section|menu))?(?:\s+(?:for|at))?\s*,?$/i)
      ?? rest.match(/^new item\s*:?\s*["']?(.+?)["']?\s+(?:to|in|into|under|on)\s+(?:the\s+)?(.+?)\s*,?$/i)
    if (!m) return null
    const name = titleCase(m[1].replace(/\s+(?:for|at)$/i, ''))
    const cat = this.one(m[2], ['category'])
    if (!cat) return null
    if ('ambiguous' in cat) return null
    if (this.cat.find(m[2], ['item', 'category'])[0]?.entity.kind === 'item') return null
    // "add extras to flame burger" is a modifier, not a new item.
    if (this.cat.resolve(name, ['modifierGroup', 'item']).kind === 'one' && (this.cat.find(name, ['modifierGroup', 'item'])[0]?.score ?? 0) > 0.85) return null
    const step: PlanStep = { skill: 'menu.item.create', input: { name, category: cat.name, ...(p ? { price: p.value } : {}) } }
    if (!p) return { kind: 'ask', question: `What should ${name} cost?`, step, field: 'price', type: 'number' }
    return { kind: 'plan', steps: [step], confidence: 0.9 }
  }

  /* ───────── delete ───────── */
  private del(c: string): Clause {
    const m = c.match(/^(?:delete|permanently (?:remove|delete)|get rid of|trash|nuke|destroy)\s+(?:the\s+)?(.+?)(?:\s+(?:from the menu|off the menu|completely|permanently|for good|entirely))?$/i)
      ?? c.match(/^remove\s+(?:the\s+)?(.+?)\s+(?:completely|permanently|for good|entirely)$/i)
    if (!m) return null
    const isCat = /\b(category|section)\b/i.test(m[1])
    const e = this.one(m[1].replace(/\b(category|section|item)\b/gi, '').trim(), isCat ? ['category'] : ['item', 'category'])
    if (!e) return { kind: 'unknown', reason: `nothing called "${m[1]}"` }
    const mk = (x: Entity): PlanStep => (x.kind === 'category' ? { skill: 'menu.category.delete', input: { category: x.name } } : { skill: 'menu.item.delete', input: { item: x.name } })
    if ('ambiguous' in e) return this.clarify(e, mk, 'should I delete')
    return { kind: 'plan', steps: [mk(e)], confidence: 0.95 }
  }

  /* ───────── duplicate ───────── */
  private duplicate(c: string): Clause {
    const m = c.match(/^(?:duplicate|copy|clone)\s+(?:the\s+)?(.+?)(?:\s+(?:as|and call it|and name it|named|called|into)\s+["']?(.+?)["']?)?$/i)
    if (!m) return null
    const e = this.one(m[1], ['item'])
    if (!e) return { kind: 'unknown', reason: `no item "${m[1]}"` }
    const mk = (x: Entity): PlanStep => ({ skill: 'menu.item.duplicate', input: { item: x.name, ...(m[2] ? { newName: titleCase(m[2]) } : {}) } })
    if ('ambiguous' in e) return this.clarify(e, mk, 'should I copy')
    return { kind: 'plan', steps: [mk(e)], confidence: 0.93 }
  }

  /* ───────── inventory ───────── */
  private inventory(c: string): Clause {
    const track = c.match(/^(stop|start|turn off|turn on|disable|enable|pause|resume)\s+(?:tracking\s+)?(?:the\s+)?(?:inventory|stock)(?:\s+tracking)?\s+(?:for|on)\s+(?:the\s+)?(.+)$/i)
      ?? c.match(/^(stop|start)\s+tracking\s+(?:the\s+)?(.+?)(?:\s+(?:inventory|stock))?$/i)
    if (track) {
      const e = this.one(track[2], ['item'])
      if (!e || 'ambiguous' in e) return e ? this.clarify(e, (x) => ({ skill: 'menu.item.set_inventory', input: { item: x.name, track: /start|turn on|enable|resume/i.test(track[1]) } }), 'did you mean') : null
      return { kind: 'plan', steps: [{ skill: 'menu.item.set_inventory', input: { item: e.name, track: /start|turn on|enable|resume/i.test(track[1]) } }], confidence: 0.92 }
    }
    let item: string | undefined, stock: number | undefined, adjust: number | undefined
    let m = c.match(/^(?:set|update|change|make)?\s*(?:the\s+)?(?:stock|inventory|count|qty|quantity)\s+(?:of|for|on)\s+(?:the\s+)?(.+?)\s+(?:to|at|=|is)\s*(-?\d+)$/i)
    if (m) { item = m[1]; stock = Number(m[2]) }
    m ??= c.match(/^(?:set\s+)?(?:the\s+)?(.+?)\s+(?:stock|inventory|count)\s*(?:to|at|=|is|:)?\s*(-?\d+)$/i)
    if (m && item === undefined) { item = m[1]; stock = Number(m[2]) }
    const have = c.match(/^(?:we\s+)?(?:only\s+)?(?:have|got|has)\s+(?:only\s+)?(\d+)\s+(?:more\s+)?(.+?)(?:\s+(?:left|remaining|in stock|on hand))?$/i) ?? c.match(/^(?:there(?:'s| are| is)\s+)?(?:only\s+)?(\d+)\s+(.+?)\s+(?:left|remaining|on hand)$/i)
    if (have && item === undefined) { item = have[2]; stock = Number(have[1]) }
    const add = c.match(/^(?:add|received?|got|restock(?:ed)?)\s+(\d+)\s+(?:more\s+)?(?:to\s+)?(?:the\s+)?(.+?)(?:\s+(?:stock|inventory|count))?$/i)
    if (add && item === undefined && /\b(stock|inventory|more|received?|restock)/i.test(c)) { item = add[2]; adjust = Number(add[1]) }
    const sub = c.match(/^(?:remove|subtract|take(?: away)?|minus|used|sold|wasted|toss(?:ed)?)\s+(\d+)\s+(?:from\s+)?(?:the\s+)?(.+?)(?:\s+(?:stock|inventory|count))?$/i)
    if (sub && item === undefined && /\b(stock|inventory|used|wasted|toss)/i.test(c)) { item = sub[2]; adjust = -Number(sub[1]) }
    if (item === undefined) return null
    const e = this.one(item.replace(/\b(stock|inventory)\b/gi, ''), ['item'])
    if (!e) return { kind: 'unknown', reason: `no item "${item}"` }
    const mk = (x: Entity): PlanStep => ({ skill: 'menu.item.set_inventory', input: { item: x.name, ...(stock !== undefined ? { stock } : { adjust }) } })
    if ('ambiguous' in e) return this.clarify(e, mk, 'did you mean')
    return { kind: 'plan', steps: [mk(e)], confidence: 0.9 }
  }

  /* ───────── attach/detach modifier groups on an item ───────── */
  private itemModifiers(c: string): Clause {
    const m = c.match(/^(add|attach|put|enable|turn on|remove|detach|take|drop|disable|turn off)\s+(?:the\s+)?(.+?)\s+(?:modifiers?|options?|groups?|add-?ons?)?\s*(to|on|onto|for|off|from|off of)\s+(?:the\s+)?(.+?)(?:\s+(?:item|too))?$/i)
    if (!m) return null
    const g = this.cat.resolve(m[2], ['modifierGroup'])
    const it = this.one(m[4], ['item', 'category'])
    if (g.kind !== 'one' || g.match.score < 0.6 || !it) return null
    // "add Ranch to wing sauce" → modifier group edit, handled elsewhere (target is a group).
    if (this.cat.resolve(m[4], ['modifierGroup']).kind === 'one' && (this.cat.find(m[4], ['modifierGroup'])[0]?.score ?? 0) > 0.8) return null
    const removing = /remove|detach|take|drop|disable|turn off/i.test(m[1]) || /off|from/i.test(m[3])
    const mk = (x: Entity): PlanStep[] => (x.kind === 'category' ? this.cat.itemsIn(x.id) : [{ name: x.name }]).map((i) => ({ skill: 'menu.item.set_modifiers', input: { item: i.name, [removing ? 'remove' : 'add']: [g.match.entity.name] } }))
    if ('ambiguous' in it) return { kind: 'clarify', question: `Which "${it.span}"?`, options: it.ambiguous.map((o) => ({ label: o.entity.name, steps: mk(o.entity) })) }
    return { kind: 'plan', steps: mk(it), confidence: Math.min(0.92, g.match.score) }
  }

  /* ───────── modifier group edits ───────── */
  private modifierGroup(c: string): Clause {
    const create = c.match(/^(?:create|add|make|new)\s+(?:a\s+)?(?:new\s+)?(?:modifier|option|add-?on)\s+group\s+(?:called\s+|named\s+)?["']?(.+?)["']?(?:\s+with\s+(.+))?$/i)
    if (create) {
      const opts = create[2] ? parseOptions(create[2]) : []
      return { kind: 'plan', steps: [{ skill: 'menu.modifier_group.upsert', input: { group: titleCase(create[1]), create: true, ...(opts.length ? { addOptions: opts } : {}) } }], confidence: 0.9 }
    }
    const req = c.match(/^make\s+(?:the\s+)?(.+?)\s+(optional|required|mandatory|not required)$/i)
    if (req) {
      const g = this.cat.resolve(req[1].replace(/\b(modifier|group|options?)\b/gi, ''), ['modifierGroup'])
      if (g.kind !== 'one') return null
      return { kind: 'plan', steps: [{ skill: 'menu.modifier_group.upsert', input: { group: g.match.entity.name, required: /^(required|mandatory)$/i.test(req[2]) } }], confidence: 0.9 }
    }
    const max = c.match(/^(?:let\s+(?:people|customers|them|guests)\s+(?:pick|choose|select)|allow)\s+up to\s+(\d+)\s+(.+)$/i) ?? c.match(/^(.+?)\s+max(?:imum)?\s+(?:of\s+)?(\d+)$/i)
    if (max) {
      const [n, span] = /^\d+$/.test(max[1]) ? [Number(max[1]), max[2]] : [Number(max[2]), max[1]]
      const g = this.cat.resolve(span.replace(/\b(modifier|group|options?)\b/gi, ''), ['modifierGroup'])
      if (g.kind !== 'one') return null
      return { kind: 'plan', steps: [{ skill: 'menu.modifier_group.upsert', input: { group: g.match.entity.name, max: n } }], confidence: 0.88 }
    }
    const add = c.match(/^(?:add|include|offer)\s+(.+?)\s+(?:to|in|on|as an? option (?:in|for|on))\s+(?:the\s+)?(.+?)(?:\s+(?:options?|group|modifiers?|choices|add-?ons))?$/i)
    if (add) {
      const g = this.cat.resolve(add[2], ['modifierGroup'])
      if (g.kind !== 'one' || g.match.score < 0.72) return null
      if (this.cat.resolve(add[2], ['item']).kind === 'one' && (this.cat.find(add[2], ['item'])[0]?.score ?? 0) >= g.match.score) return null
      const opts = parseOptions(add[1])
      if (!opts.length) return null
      return { kind: 'plan', steps: [{ skill: 'menu.modifier_group.upsert', input: { group: g.match.entity.name, addOptions: opts } }], confidence: 0.9 }
    }
    const rm = c.match(/^(?:remove|drop|take out|delete|get rid of)\s+(?:the\s+)?(.+?)\s+(?:from|out of|in)\s+(?:the\s+)?(.+?)(?:\s+(?:options?|group|modifiers?|choices))?$/i)
    if (rm) {
      const g = this.cat.resolve(rm[2], ['modifierGroup'])
      if (g.kind !== 'one' || g.match.score < 0.72) return null
      const group = this.cat.snap.modifierGroups.find((x) => x.id === g.match.entity.id)!
      const names = rm[1].split(/\s*(?:,|\band\b|&)\s*/).map((n) => strip(n)).filter(Boolean)
      const resolved = names.map((n) => group.options.find((o) => o.name.toLowerCase() === n.toLowerCase()) ?? group.options.find((o) => o.name.toLowerCase().includes(n.toLowerCase())))
      if (resolved.some((o) => !o)) return null
      return { kind: 'plan', steps: [{ skill: 'menu.modifier_group.upsert', input: { group: group.name, removeOptions: resolved.map((o) => o!.name) } }], confidence: 0.9 }
    }
    return null
  }

  /* ───────── sizes ───────── */
  private size(c: string): Clause {
    const add = c.match(/^add\s+(?:a\s+|an\s+)?(.+?)\s+size\s+(?:to|for|on)\s+(?:the\s+)?(.+?)\s+(?:for|at|@)\s*\$?\s?(\d+(?:\.\d{1,2})?)$/i)
    const rm = c.match(/^(?:remove|delete|drop)\s+(?:the\s+)?(.+?)\s+size\s+(?:from|on|for)\s+(?:the\s+)?(.+)$/i)
    const set = c.match(/^(?:(?:set|change|make)\s+)?(?:the\s+|a\s+)?(.+?)\s+(?:size\s+)?(?:of|for|on)\s+(?:the\s+)?(.+?)\s+(?:is now|to|is|=|should be|at)\s*\$?\s?(\d+(?:\.\d{1,2})?)$/i)
    if (add) {
      const e = this.one(add[2], ['item'])
      if (!e || 'ambiguous' in e) return null
      return { kind: 'plan', steps: [{ skill: 'menu.item.set_size', input: { item: e.name, size: titleCase(add[1]), price: parseFloat(add[3]) } }], confidence: 0.92 }
    }
    if (rm) {
      const e = this.one(rm[2], ['item'])
      if (!e || 'ambiguous' in e) return null
      return { kind: 'plan', steps: [{ skill: 'menu.item.set_size', input: { item: e.name, size: titleCase(rm[1]), remove: true } }], confidence: 0.92 }
    }
    if (set) {
      const e = this.one(set[2], ['item'])
      if (!e || 'ambiguous' in e) return null
      const item = this.cat.snap.items.find((i) => i.id === e.id)!
      const size = item.sizes.find((s) => s.name.toLowerCase() === strip(set[1]).toLowerCase())
      if (!size) return null
      return { kind: 'plan', steps: [{ skill: 'menu.item.set_size', input: { item: e.name, size: size.name, price: parseFloat(set[3]) } }], confidence: 0.9 }
    }
    return null
  }

  /* ───────── tax ───────── */
  private tax(c: string): Clause {
    const set = c.match(/^(?:set|change|make|put)?\s*(?:the\s+)?(?:item\s+)?tax(?:\s+rate)?\s+(?:on|for|of)\s+(?:the\s+)?(.+?)\s+(?:to|at|=)\s*(\d+(?:\.\d+)?)\s*%?$/i)
      ?? c.match(/^(.+?)\s+tax(?:\s+rate)?\s*(?:to|at|=|is|:)?\s*(\d+(?:\.\d+)?)\s*%$/i)
    const clear = c.match(/^(?:clear|remove|reset|drop)\s+(?:the\s+)?(?:item\s+)?tax(?:\s+(?:override|rate))?\s+(?:on|for|from)\s+(?:the\s+)?(.+)$/i)
    const m = set ?? clear
    if (!m) return null
    const e = this.one(m[1], ['item'])
    if (!e || 'ambiguous' in e) return e ? this.clarify(e, (x) => ({ skill: 'menu.item.set_tax', input: { item: x.name, rate: set ? parseFloat(set[2]) : null } }), 'did you mean') : null
    return { kind: 'plan', steps: [{ skill: 'menu.item.set_tax', input: { item: e.name, rate: set ? parseFloat(set[2]) : null } }], confidence: 0.92 }
  }

  /* ───────── categories ───────── */
  private categoryCreate(c: string): Clause {
    const m = c.match(/^(?:add|create|make|start)\s+(?:a\s+)?(?:new\s+)?(?:category|section)\s+(?:called\s+|named\s+|for\s+)?["']?(.+?)["']?(?:\s*(?:—|–|-|:|with (?:the )?description)\s*(.+))?$/i)
      ?? c.match(/^(?:add|create|make|start)\s+(?:a\s+)?(?:new\s+)?["']?(.+?)["']?\s+(?:category|section)(?:\s*(?:—|–|-|:|with (?:the )?description)\s*(.+))?$/i)
    if (!m) return null
    return { kind: 'plan', steps: [{ skill: 'menu.category.create', input: { name: titleCase(m[1]), ...(m[2] ? { description: m[2].trim() } : {}) } }], confidence: 0.92 }
  }

  private reorder(c: string): Clause {
    const m = c.match(/^(?:move|put|shift|bump|drag|place)\s+(?:the\s+)?(.+?)\s+(?:category\s+|section\s+)?(?:to\s+(?:the\s+)?)?(up(?: one)?|down(?: one)?|top|bottom|first|last|front|end|(?:position|spot|slot|number|#)\s*(\d+)|(\d+)(?:st|nd|rd|th)(?:\s+(?:place|position|spot))?)$/i)
      ?? c.match(/^make\s+(?:the\s+)?(.+?)\s+(?:the\s+)?(first|last|(\d+)(?:st|nd|rd|th))\s+(?:category|section)$/i)
    if (!m) return null
    const e = this.one(m[1].replace(/\b(category|section)\b/gi, ''), ['category'])
    if (!e || 'ambiguous' in e) return null
    const w = m[2].toLowerCase()
    const to = /^up/.test(w) ? 'up' : /^down/.test(w) ? 'down' : /^(top|first|front)$/.test(w) ? 'top' : /^(bottom|last|end)$/.test(w) ? 'bottom' : Number(m[3] ?? m[4] ?? w.match(/\d+/)?.[0])
    return { kind: 'plan', steps: [{ skill: 'menu.category.reorder', input: { category: e.name, to } }], confidence: 0.9 }
  }

  /* ───────── publish ───────── */
  private publish(c: string): Clause {
    if (/^(?:update provider menus?|publish|sync|push it|push changes|send it out)$/i.test(c)
      || /^(?:push|publish|sync|send|update|refresh|resync)\s+(?:the\s+)?(?:menu|menus|changes|everything|it)\b.*$/i.test(c) && !/\b(price|description|name|stock)\b/i.test(c)) {
      return { kind: 'plan', steps: [{ skill: 'menu.publish', input: {} }], confidence: 0.95 }
    }
    return null
  }

  /* ───────── order acceptance ───────── */
  private acceptance(c: string): Clause {
    const l = c.toLowerCase()
    if (/\b(resume|unpause|un-pause|start (?:taking|accepting)|turn (?:orders |ordering |online orders )?back on|back open|we'?re (?:back )?open|we are (?:back )?open|reopen|re-open|open (?:back )?up|accept(?:ing)? orders(?: again)?|take orders again)\b/.test(l) && !/\b(order\s+#?\d)/.test(l)) {
      return { kind: 'plan', steps: [{ skill: 'store.set_acceptance', input: { mode: 'accepting' } }], confidence: 0.93 }
    }
    const pauseWords = /\b(pause|hold|snooze|slammed|swamped|backed up|overwhelmed|slow down|stop (?:orders |taking orders )?for)\b/.test(l)
    const stopWords = /\b(stop (?:taking|accepting)(?: orders)?|close (?:the store|up|early|for (?:today|tonight|the (?:day|night)))|closed for (?:today|tonight|the (?:day|night))|shut (?:it |things )?down|done for (?:the day|today|tonight)|we'?re closed$|we are closed$|no more orders|turn off (?:orders|ordering|online orders))\b/.test(l)
    if (!pauseWords && !stopWords) return null
    if (!/\b(orders?|ordering|online|kitchen|store|everything|delivery|deliveries|slammed|swamped|backed up|overwhelmed|we'?re|we are|shut|done|close|closed|for \d+|minutes?|mins?|hour)\b/.test(l)) return null
    if (stopWords && !/\bfor\s+(?:\d+|an?|half|one)\b/.test(l)) return { kind: 'plan', steps: [{ skill: 'store.set_acceptance', input: { mode: 'stop_today' } }], confidence: 0.9 }
    let minutes = 30
    const mm = l.match(/(\d+)\s*(?:m|min|mins|minutes)\b/) ?? l.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/)
    if (mm) minutes = /h/.test(mm[0].replace(/\d/g, '')) && !/min|m\b/.test(mm[0]) ? Number(mm[1]) * 60 : Number(mm[1])
    else if (/\b(an?|one) (?:hour|hr)\b/.test(l)) minutes = 60
    else if (/\bhalf (?:an )?hour\b/.test(l)) minutes = 30
    else if (/\bquarter (?:of an )?hour\b/.test(l)) minutes = 15
    return { kind: 'plan', steps: [{ skill: 'store.set_acceptance', input: { mode: 'pause', minutes } }], confidence: 0.9 }
  }

  private location(c: string): Clause {
    const m = c.match(/\b(?:switch|change|go|move|jump|flip)\b.*?\b(?:to|over to)\s+(?:the\s+)?(hayward|fremont|san leandro|sl)\b/i) ?? c.match(/^(?:use|open|pick)\s+(?:the\s+)?(hayward|fremont|san leandro)\b/i)
    if (!m) return null
    const id = /san|sl/i.test(m[1]) ? 'sanleandro' : m[1].toLowerCase()
    return { kind: 'plan', steps: [{ skill: 'store.switch_location', input: { store: id } }], confidence: 0.95 }
  }

  /* ───────── orders ───────── */
  private ordersList(c: string): Clause {
    if (/^(?:(?:any|what|which|show(?: me)?|list|how many|check(?: the)?|whats?|what's|see)\b.*\b(?:orders?|tickets?|queue)\b|(?:the\s+)?(?:order\s+)?queue|orders|new orders\??|open orders|active orders|live orders)$/i.test(c)
      && !/\b(?:accept|ready|complete|reject|cancel)\b/i.test(c) && !/\b(?:sales|revenue|made)\b/i.test(c)) {
      return { kind: 'plan', steps: [{ skill: 'orders.list_active', input: {} }], confidence: 0.92 }
    }
    return null
  }

  private orderUpdate(c: string): Clause {
    const l = c.toLowerCase()
    const to = /\b(reject|cancel|decline|refuse|deny)\b/.test(l) ? 'canceled'
      : /\b(complete[d]?|picked up|delivered|out the door|close (?:it )?out|handed off|done)\b/.test(l) ? 'completed'
        : /\b(ready|up|done cooking|plated|bagged)\b/.test(l) ? 'ready'
          : /\b(accept|confirm|start|prepare|fire|begin|take)\b/.test(l) ? 'preparing' : null
    if (!to) return null
    const scope = /\ball (?:the )?new\b|\bevery new\b|\ball incoming\b/.test(l) ? 'all_new' : /\b(?:all|everything) (?:that'?s |that is )?ready\b|\ball ready\b/.test(l) ? 'all_ready' : /\ball (?:the )?(?:preparing|cooking|in progress)\b/.test(l) ? 'all_preparing' : null
    if (scope && /\border|ticket|everything|all\b/.test(l)) return { kind: 'plan', steps: [{ skill: 'orders.update_status', input: { scope, to } }], confidence: 0.88 }
    const refs = [...c.matchAll(/(?:#\s?|\b(?:dd|ue|gh)-?)?\b\d{4}[a-z]?\b/gi)].map((m) => m[0].replace(/\s/g, ''))
    if (!refs.length) {
      if (this.focus.order && /\b(it|that|this|the order)\b/.test(l)) refs.push(this.focus.order)
      else return null
    }
    const ok: string[] = []
    for (const r of refs) {
      const hits = this.cat.findOrder(r)
      if (hits.length === 1) ok.push(hits[0].number)
      else if (hits.length > 1) return { kind: 'clarify', question: `Which order ${r}?`, options: hits.slice(0, 4).map((o) => ({ label: `${o.number} (${o.customer}, ${o.status})`, steps: [{ skill: 'orders.update_status', input: { orders: [o.number], to } }] })) }
      else return { kind: 'unknown', reason: `no order ${r}` }
    }
    return { kind: 'plan', steps: [{ skill: 'orders.update_status', input: { orders: ok, to } }], confidence: 0.93 }
  }

  /* ───────── lookups ───────── */
  private lookup(c: string): Clause {
    const l = c.toLowerCase()
    const isQ = /^(is|are|do we have|does|did|what|whats|what's|which|how much|how many|price of|cost of|show|list|tell me|any|check)\b/.test(l) || /\?$/.test(c)
    if (!isQ) return null
    if (/\b(86'?d|86ed|sold out|unavailable|out of stock|not available|off the menu|disabled)\b/.test(l) && /^(what|whats|what's|which|show|list|tell me|any|is anything|anything)/.test(l)) return { kind: 'plan', steps: [{ skill: 'menu.lookup', input: { filter: 'unavailable' } }], confidence: 0.9 }
    if (/\b(low|running low|low on stock|low stock|low inventory)\b/.test(l)) return { kind: 'plan', steps: [{ skill: 'menu.lookup', input: { filter: 'low_stock' } }], confidence: 0.9 }
    if (/\b(no|without|missing) (photos?|pictures?|images?|pics?)\b/.test(l)) return { kind: 'plan', steps: [{ skill: 'menu.lookup', input: { filter: 'no_photo' } }], confidence: 0.9 }
    if (/\bhidden\b/.test(l)) return { kind: 'plan', steps: [{ skill: 'menu.lookup', input: { filter: 'hidden' } }], confidence: 0.9 }
    if (/\bnew items?\b/.test(l)) return { kind: 'plan', steps: [{ skill: 'menu.lookup', input: { filter: 'new' } }], confidence: 0.9 }
    const inCat = l.match(/^(?:what'?s|whats|what is|what are|show(?: me)?|list)\s+(?:in|on|under)\s+(?:the\s+)?(.+?)(?:\s+(?:category|section|menu))?$/) ?? l.match(/^(?:show(?: me)?|list)\s+(?:the\s+)?(.+?)(?:\s+(?:category|section|items))$/)
    if (inCat) {
      const e = this.one(inCat[1], ['category'])
      if (e && !('ambiguous' in e)) return { kind: 'plan', steps: [{ skill: 'menu.lookup', input: { category: e.name, filter: 'all' } }], confidence: 0.9 }
    }
    const q = l.match(/^(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:available|in stock|on(?: the menu)?|86'?d|sold out|out|back|live|hidden|on doordash|showing)$/)
      ?? l.match(/^(?:do we (?:have|still have|got)|did we run out of|are we out of|how many)\s+(?:the\s+|any\s+)?(.+?)(?:\s+(?:left|in stock|available|remaining))?$/)
      ?? l.match(/^(?:how much (?:is|are|does|do|for)|price (?:of|for)|cost of|what(?:'s| is| does) the price of|what does|what do)\s+(?:the\s+|a\s+|an\s+)?(.+?)(?:\s+(?:cost|go for|run|sell for))?$/)
      ?? l.match(/^(?:what(?:'s| is)\s+the\s+)?(?:status|price) (?:of|on|for)\s+(?:the\s+)?(.+)$/)
    if (q) {
      const r = this.resolveList(q[1], ['item'])
      if (r && 'ambiguous' in r) return this.clarify(r, (e) => ({ skill: 'menu.lookup', input: { items: [e.name] } }), 'did you mean')
      if (r) return { kind: 'plan', steps: [{ skill: 'menu.lookup', input: { items: r.ok.map((e) => e.name) } }], confidence: r.score }
    }
    return null
  }

  private sales(c: string): Clause {
    const l = c.toLowerCase()
    if (!/\b(sales|revenue|made|make|money|numbers|avg ticket|average ticket|ticket size|best ?sellers?|top sellers?|top items|best items|how('?d| did) we do|performance|gross|commission|earn(?:ed|ings)?)\b/.test(l)) return null
    const days = /\b(today|so far|tonight|this morning)\b/.test(l) ? 1 : /\b(month|30|thirty)\b/.test(l) ? 30 : /\b(two weeks|2 weeks|14|fortnight)\b/.test(l) ? 14 : 7
    return { kind: 'plan', steps: [{ skill: 'insights.sales_report', input: { days } }], confidence: 0.9 }
  }

  private brief(c: string): Clause {
    if (/\b(brief|briefing|summary|rundown|status report|sitrep|catch me up|how are we doing|how'?s (?:it going|business|the store|everything|today)|what needs (?:my )?attention|anything i should know|what'?s (?:up|going on|happening)|^status$|good morning|morning)\b/i.test(c)) {
      return { kind: 'plan', steps: [{ skill: 'insights.daily_brief', input: {} }], confidence: 0.9 }
    }
    return null
  }

  private chargebacks(c: string): Clause {
    const d = c.match(/^(?:dispute|fight|contest|challenge|appeal)\s+(?:the\s+)?(?:chargeback\s+)?(?:on|for)?\s*(?:order\s+)?(#?(?:[a-z]{2}-)?\d{3,5}[a-z]?)\b\s*(?::|-|—|–|because|since|,|as)?\s*(.*)$/i)
    if (d) {
      const step: PlanStep = { skill: 'chargebacks.dispute', input: { order: d[1].toUpperCase(), note: d[2]?.trim() || '' } }
      if ((d[2] ?? '').trim().length < 10) return { kind: 'ask', question: `What happened with ${d[1].toUpperCase()}? I'll send your note with the dispute.`, step, field: 'note', type: 'text' }
      return { kind: 'plan', steps: [step], confidence: 0.92 }
    }
    if (/\b(chargebacks?|disputes?|refund claims?)\b/i.test(c)) return { kind: 'plan', steps: [{ skill: 'chargebacks.list', input: {} }], confidence: 0.9 }
    return null
  }

  /* ───────── hours ───────── */
  private hours(c: string): Clause {
    const days = parseDays(c)
    if (!days.length) return null
    const l = c.toLowerCase()
    if (!/\b(open|close[sd]?|closing|hours|from|until|till|til|to|-|am|pm|noon|midnight)\b/.test(l)) return null
    const closed = /\b(closed?|shut)\b(?!\s+at)(?!\s+(?:\w+\s+)?(?:at|by|around))/.test(l) && !/\b(open|from)\b/.test(l)
    if (closed) return { kind: 'plan', steps: [{ skill: 'schedule.set_hours', input: { days, open: false } }], confidence: 0.9 }
    const range = l.match(/(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)\s*(?:to|-|–|till|til|until|through)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight|close)/)
    const until = l.match(/\b(?:till|til|until|to|close at|closing at|open until|open till)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\b/)
    const from = l.match(/\b(?:open(?:ing)? at|from|starting at|start at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon)\b/)
    const input: Record<string, unknown> = { days, open: true }
    if (range) { input.from = toTime(range[1], 'open'); if (range[2] !== 'close') input.to = toTime(range[2], 'close') }
    else { if (from) input.from = toTime(from[1], 'open'); if (until) input.to = toTime(until[1], 'close') }
    if (!input.from && !input.to && !/\bopen\b/.test(l)) return null
    return { kind: 'plan', steps: [{ skill: 'schedule.set_hours', input }], confidence: 0.88 }
  }

  /* ───────── follow-ups: "the wings too", "and the fries" ───────── */
  private followUp(c: string): Clause {
    const last = this.focus.lastStep
    if (!last) return null
    const m = c.match(/^(?:and\s+|also\s+|same (?:for|with)\s+|what about\s+|plus\s+)?(?:the\s+)?(.+?)(?:\s+(?:too|as well|also))?$/i)
    if (!m || !/(too|as well|also|^and |^same |^what about|^plus )/i.test(c)) return null
    const r = this.resolveList(m[1], ['item'])
    if (!r || 'ambiguous' in r) return null
    const names = r.ok.map((e) => e.name)
    const input = { ...last.input }
    if ('items' in input) input.items = names
    else if ('item' in input && names.length === 1) input.item = names[0]
    else return null
    return { kind: 'plan', steps: [{ skill: last.skill, input }], confidence: 0.85 }
  }
}

/* ─────────────────────────────── helpers ─────────────────────────────── */
export function titleCase(s: string) {
  const small = new Set(['with', 'and', 'of', 'the', 'a', 'in', 'on', 'for', 'or'])
  return s.trim().replace(/\s+/g, ' ').split(' ').map((w, i) => (/[A-Z]/.test(w.slice(1)) ? w : i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
}

/** "Ranch for 50 cents, Caesar $0.50 and Tahini" → options */
export function parseOptions(s: string): { name: string; price: number }[] {
  return s.split(/\s*(?:,\s*and\s+|,|\s+and\s+|&)\s*/i).map((part) => {
    const p = part.trim()
    const m = p.match(new RegExp(String.raw`^(.+?)\s*(?:\(|\s)(?:for|at|@|\+|plus)?\s*((?:\$\s?)?${NUM}\s*(?:cents?|¢|dollars?|bucks?)?|free)\)?$`, 'i'))
    if (m && !/^(?:a|an)$/i.test(m[2].trim())) {
      const a = /free/i.test(m[2]) ? { value: 0 } : amount(m[2].replace(/\s+/g, ' '))
      if (a) return { name: titleCase(m[1].replace(/\s+(for|at)$/i, '')), price: Math.round(a.value * 100) / 100 }
    }
    return { name: titleCase(p), price: 0 }
  }).filter((o) => o.name)
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
export function parseDays(s: string): (typeof DAY_NAMES)[number][] {
  const l = s.toLowerCase()
  if (/\b(every ?day|daily|all week|7 days)\b/.test(l)) return [...DAY_NAMES]
  const out = new Set<(typeof DAY_NAMES)[number]>()
  if (/\bweekdays?\b/.test(l)) DAY_NAMES.slice(0, 5).forEach((d) => out.add(d))
  if (/\bweekends?\b/.test(l)) ['Saturday', 'Sunday'].forEach((d) => out.add(d as (typeof DAY_NAMES)[number]))
  const abbr = (w: string) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(w.slice(0, 3))
  const D = '(mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:nesday)?s?|thu(?:rs?(?:day)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)'
  const range = l.match(new RegExp(`\\b${D}\\s*(?:-|–|to|through|thru)\\s*${D}\\b`))
  if (range) {
    const [a, b] = [abbr(range[1]), abbr(range[2])]
    if (a >= 0 && b >= 0) for (let i = a; ; i = (i + 1) % 7) { out.add(DAY_NAMES[i]); if (i === b) break }
  }
  for (const m of l.matchAll(new RegExp(`\\b${D}\\b`, 'g'))) { const i = abbr(m[1]); if (i >= 0) out.add(DAY_NAMES[i]) }
  return DAY_NAMES.filter((d) => out.has(d))
}

/** "11", "11am", "9:30 pm", "noon", "midnight" → "HH:MM", inferring am/pm from whether it's an open or close time. */
export function toTime(raw: string, role: 'open' | 'close'): string {
  const s = raw.trim().toLowerCase()
  if (s === 'noon') return '12:00'
  if (s === 'midnight') return '00:00'
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/)
  if (!m) return s
  let h = Number(m[1])
  const min = m[2] ?? '00'
  const ap = m[3]?.[0]
  if (ap === 'p' && h < 12) h += 12
  else if (ap === 'a' && h === 12) h = 0
  else if (!ap) {
    if (role === 'close' && h >= 1 && h <= 11) h += 12 // "till 10" → 22:00
    if (role === 'open' && h >= 1 && h <= 4) h += 12 // "open at 2" → 14:00
  }
  return `${String(h).padStart(2, '0')}:${min}`
}
