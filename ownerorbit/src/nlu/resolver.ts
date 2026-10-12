import type { Snapshot } from '../core/types.ts'
import { STORES } from '../core/types.ts'

/**
 * Fuzzy entity resolution against the live catalog.
 * Scoring = IDF-weighted token overlap (so "nuggets" matters more than "chicken"), with
 * typo-tolerant token matching (Damerau-Levenshtein) and owner shorthand aliases.
 */

export type EntityKind = 'item' | 'category' | 'modifierGroup' | 'store' | 'order' | 'option'
export interface Entity { kind: EntityKind; id: string; name: string; parentId?: string }
export interface Match { entity: Entity; score: number }

const STOP = new Set(['the', 'a', 'an', 'our', 'my', 'all', 'of', 'item', 'items', 'please', 'pls', 'some', 'any', 'those', 'these', 'that', 'this', 'on', 'for', 'menu'])
// Words that appear in names but carry little identity on their own.
const SOFT = new Set(['add', 'with', 'fries', 'side', 'pcs', 'pc', 'meal', 'platter', 'store', 'falafel', 'flare'])

// Kitchen shorthand → canonical words.
const ALIASES: Record<string, string> = {
  nugs: 'nuggets', nuggies: 'nuggets', nug: 'nuggets', tendies: 'tenders', chx: 'chicken', chkn: 'chicken', ckn: 'chicken',
  bbq: 'bbq', 'b.b.q': 'bbq', kebab: 'kabab', kebabs: 'kabab', kabob: 'kabab', kabobs: 'kabab', shawarma: 'chicken',
  cheeseburger: 'cheese burger', cheeseburgers: 'cheese burger', burgers: 'burger', wraps: 'wrap', 'w/': 'with',
  calamari: 'calamari', squid: 'calamari', hummous: 'hummus', humus: 'hummus', ganoush: 'ganoush', ghanoush: 'ganoush',
  ganouj: 'ganoush', 'baba': 'baba', chops: 'chops', 'lambchops': 'lamb chops', dd: 'doordash', ue: 'uber', gh: 'grubhub',
  sl: 'san leandro', 'san-leandro': 'san leandro', kid: 'kids', kids: 'kids', apps: 'starters', appetizers: 'starters', appetizer: 'starters',
  mains: 'entrees', entree: 'entrees', plates: 'entrees', drinks: 'drinks', mods: 'modifier', sauce: 'sauce', sauces: 'sauce',
}

export function tokens(s: string): string[] {
  return s.toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9#\-\s.]/g, ' ')
    .split(/\s+/)
    .flatMap((t) => (ALIASES[t] ?? t).split(' '))
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((t) => t && !STOP.has(t))
    .map(stem)
}

export function stem(t: string) {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y'
  if (t.length > 4 && /(ch|sh|x)es$/.test(t)) return t.slice(0, -2)
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  return t
}

function dl(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

function tokSim(q: string, c: string): number {
  if (q === c) return 1
  if (c.startsWith(q) && q.length >= 3) return 0.85 // "nug" → "nugget"
  if (q.length >= 4 && c.length >= 4) {
    const dist = dl(q, c)
    if (dist === 1) return 0.85
    if (dist === 2 && Math.min(q.length, c.length) >= 7) return 0.7
  }
  return 0
}

export class Catalog {
  readonly entities: Entity[] = []
  private toks = new Map<Entity, string[]>()
  private idf = new Map<string, number>()

  constructor(public snap: Snapshot) {
    for (const i of snap.items) this.entities.push({ kind: 'item', id: i.id, name: i.name, parentId: i.categoryId })
    for (const c of snap.categories) this.entities.push({ kind: 'category', id: c.id, name: c.name })
    for (const g of snap.modifierGroups) {
      this.entities.push({ kind: 'modifierGroup', id: g.id, name: g.name })
      for (const o of g.options) this.entities.push({ kind: 'option', id: o.id, name: o.name, parentId: g.id })
    }
    for (const s of STORES) this.entities.push({ kind: 'store', id: s.id, name: s.name })
    const df = new Map<string, number>()
    for (const e of this.entities) {
      if (e.kind === 'order') continue
      const t = tokens(e.name)
      this.toks.set(e, t)
      for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1)
    }
    const n = this.entities.length
    for (const [w, c] of df) this.idf.set(w, Math.log(1 + n / c) * (SOFT.has(w) ? 0.45 : 1))
  }

  private w(t: string) { return this.idf.get(t) ?? 1.5 }

  score(query: string, e: Entity): number {
    const q = tokens(query)
    const c = this.toks.get(e) ?? tokens(e.name)
    if (!q.length || !c.length) return 0
    if (q.join(' ') === c.join(' ')) return 1
    let matchedC = 0, matchedQ = 0, totalC = 0, totalQ = 0
    const used = new Set<number>()
    for (const qt of q) {
      totalQ += this.w(qt)
      let best = 0, bi = -1
      c.forEach((ct, i) => { if (used.has(i)) return; const s = tokSim(qt, ct); if (s > best) { best = s; bi = i } })
      if (bi >= 0) { used.add(bi); matchedQ += best * this.w(c[bi]); matchedC += best * this.w(c[bi]) }
    }
    for (const ct of c) totalC += this.w(ct)
    const recall = matchedC / totalC // how much of the name the owner said
    const precision = matchedQ / Math.max(totalQ, 1e-9) // how much of what they said is in the name
    if (precision === 0) return 0
    return 0.62 * recall + 0.38 * precision
  }

  /** Every word the owner said appears (typo-tolerant) in this entity's name. */
  covers(span: string, e: Entity) {
    const c = this.toks.get(e) ?? tokens(e.name)
    return tokens(span).every((q) => c.some((t) => tokSim(q, t) >= 0.85))
  }

  /** Ranked candidates for a span of owner text. */
  find(span: string, kinds: EntityKind[] = ['item', 'category'], limit = 5): Match[] {
    const exact = this.entities.filter((e) => kinds.includes(e.kind) && e.name.toLowerCase() === span.trim().toLowerCase())
    if (exact.length) return exact.map((entity) => ({ entity, score: 1 }))
    return this.entities
      .filter((e) => kinds.includes(e.kind))
      .map((entity) => ({ entity, score: this.score(span, entity) }))
      .filter((m) => m.score >= 0.34)
      .sort((a, b) => b.score - a.score || a.entity.name.length - b.entity.name.length)
      .slice(0, limit)
  }

  /**
   * Decide: one confident match, an ambiguity worth asking about, or nothing.
   * Confident = clear winner by margin, or the only candidate above the bar.
   */
  resolve(span: string, kinds: EntityKind[] = ['item', 'category']): { kind: 'one'; match: Match } | { kind: 'ambiguous'; options: Match[] } | { kind: 'none' } {
    const c = this.find(span, kinds, 12)
    if (!c.length || c[0].score < 0.5) return { kind: 'none' }
    if (c[0].score === 1) return { kind: 'one', match: c[0] }
    // A query that is exactly a category ("burger" → Burgers) means the category.
    const q = tokens(span).join(' ')
    const cat = c.find((m) => m.entity.kind === 'category' && (this.toks.get(m.entity) ?? []).join(' ') === q)
    if (cat) return { kind: 'one', match: cat }
    // Generic words ("chicken", "lamb", "gyro") fully contained in several names → ask, don't guess.
    const covering = c.filter((m) => m.score >= 0.5 && this.covers(span, m.entity))
    if (covering.length > 1) return { kind: 'ambiguous', options: covering.slice(0, 4) }
    const close = c.filter((m) => m.score >= c[0].score - 0.08 && m.score >= 0.5)
    if (close.length === 1 || c[0].score - (c[1]?.score ?? 0) >= 0.12) return { kind: 'one', match: c[0] }
    return { kind: 'ambiguous', options: close.slice(0, 4) }
  }

  /** Orders: "8243", "#8243", "dd-8240d", "the doordash order from omar". */
  findOrder(span: string) {
    const s = span.toLowerCase().replace(/\s+/g, '')
    const digits = s.match(/\d{3,5}/)?.[0]
    if (!digits) return []
    return this.snap.orders.filter((o) => o.number.toLowerCase().replace(/[^a-z0-9]/g, '').includes(digits))
  }

  itemsIn(categoryId: string) { return this.snap.items.filter((i) => i.categoryId === categoryId) }
}
