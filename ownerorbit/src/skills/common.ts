import { z } from 'zod'
import { Catalog } from '../nlu/resolver.ts'
import { SkillError, STATUS_LABEL, STORES, type Category, type Check, type Item, type ModifierGroup, type Order, type Snapshot, type Status, type Verification } from '../core/types.ts'

export const zStatus = z.enum(['available', 'sold_out_today', 'sold_out', 'hidden'])
export const money = (n: number) => '$' + n.toFixed(2)
export const statusLabel = (s: Status) => STATUS_LABEL[s].toLowerCase()

function pick<T extends { id: string; name: string }>(list: T[], ref: string, kind: string, kinds: Parameters<Catalog['resolve']>[1], snap: Snapshot): T {
  const r = ref.trim().toLowerCase()
  const hit = list.find((x) => x.id.toLowerCase() === r) ?? list.find((x) => x.name.toLowerCase() === r)
  if (hit) return hit
  const res = new Catalog(snap).resolve(ref, kinds)
  if (res.kind === 'one') return list.find((x) => x.id === res.match.entity.id)!
  if (res.kind === 'ambiguous') throw new SkillError(`"${ref}" could be ${res.options.map((o) => o.entity.name).join(', ')}.`, 'Say the full name.')
  throw new SkillError(`I couldn't find a ${kind} called "${ref}".`)
}

export const findItem = (snap: Snapshot, ref: string): Item => pick(snap.items, ref, 'menu item', ['item'], snap)
export const findCategory = (snap: Snapshot, ref: string): Category => pick(snap.categories, ref, 'category', ['category'], snap)
export const findGroup = (snap: Snapshot, ref: string): ModifierGroup => pick(snap.modifierGroups, ref, 'modifier group', ['modifierGroup'], snap)
export function findStore(ref: string) {
  const r = ref.toLowerCase()
  const s = STORES.find((x) => x.id === r || x.name.toLowerCase() === r || x.name.toLowerCase().includes(r) || r.includes(x.id))
  if (!s) throw new SkillError(`No location matches "${ref}". Locations: ${STORES.map((x) => x.name.replace('Falafel Flare ', '')).join(', ')}.`)
  return s
}
export function findOrder(snap: Snapshot, ref: string): Order {
  const r = ref.trim().toLowerCase()
  const exact = snap.orders.find((o) => o.id === r || o.number.toLowerCase() === r || o.number.toLowerCase() === '#' + r)
  if (exact) return exact
  const hits = new Catalog(snap).findOrder(ref)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new SkillError(`"${ref}" matches ${hits.map((o) => o.number).join(', ')}.`)
  throw new SkillError(`I couldn't find order ${ref}.`)
}

/** Item refs may be names or a category ("everything in Kids Meal"). Expands + dedupes. */
export function expandItems(snap: Snapshot, items: string[] = [], category?: string): Item[] {
  const out = new Map<string, Item>()
  for (const ref of items) { const i = findItem(snap, ref); out.set(i.id, i) }
  if (category) for (const i of snap.items.filter((x) => x.categoryId === findCategory(snap, category).id)) out.set(i.id, i)
  if (!out.size) throw new SkillError('Which items? Name one or more items, or a category.')
  return [...out.values()]
}

export function check(name: string, expected: unknown, actual: unknown, ok = JSON.stringify(expected) === JSON.stringify(actual)): Check {
  return { name, expected, actual, ok }
}
export function verdict(checks: Check[], level: Verification['level'] = 'durable'): Verification {
  return { ok: checks.every((c) => c.ok), level, checks }
}
export const near = (a: number, b: number, eps = 0.005) => Math.abs(a - b) < eps

export function list(names: string[], max = 4) {
  if (names.length <= max) return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0] ?? ''
  return names.slice(0, max).join(', ') + ` +${names.length - max} more`
}

/** Round a price the way restaurants do: to .99 or .49 endings when asked. */
export function roundPrice(p: number, mode: 'cents' | 'nines' | 'none' = 'none') {
  if (mode === 'nines') return Math.max(0.99, Math.ceil(p) - 0.01)
  if (mode === 'cents') return Math.round(p * 100) / 100
  return Math.round(p * 100) / 100
}
