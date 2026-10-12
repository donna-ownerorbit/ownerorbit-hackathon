import type { Item } from './data.js'
import { PROVIDERS } from './data.js'

export type OrderStatus = 'new' | 'preparing' | 'ready' | 'completed' | 'canceled'

export interface Order {
  id: string
  number: string
  provider: string
  customer: string
  phone: string
  type: 'Delivery' | 'Pickup'
  status: OrderStatus
  placedAt: number
  lines: { name: string; qty: number; price: number; note?: string }[]
  subtotal: number
  tax: number
  tip: number
  total: number
  courier?: string
}

export interface Chargeback {
  id: string
  orderNumber: string
  provider: string
  date: number
  amount: number
  reason: string
  status: 'Open' | 'Disputed' | 'Won' | 'Lost'
}

const NAMES = ['Ayesha K.', 'Marcus T.', 'Priya S.', 'Daniel R.', 'Fatima A.', 'Jordan L.', 'Sofia M.', 'Omar H.', 'Emily C.', 'Hassan B.', 'Grace W.', 'Luis G.', 'Nadia F.', 'Kevin P.', 'Zara Q.', 'Tyler J.', 'Mei L.', 'Ahmed Y.', 'Rachel D.', 'Carlos V.']
const COURIERS = ['Miguel', 'Jasmine', 'Andre', 'Tina', 'Rahul', 'Brandon']
const NOTES = ['Extra garlic sauce please', 'No onions', 'Spicy!', 'Sauce on the side', undefined, undefined, undefined]
export const CHARGEBACK_REASONS = ['Missing item', 'Wrong item', 'Order never arrived', 'Food quality', 'Cold food', 'Late delivery']

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateOrders(items: Item[], count = 180): Order[] {
  const r = rng(42)
  const now = Date.now()
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
  const weighted = items.flatMap((i) => Array(Math.max(1, Math.round(i.orders30d / 40))).fill(i) as Item[])
  const orders: Order[] = []
  for (let n = 0; n < count; n++) {
    const ageMin = n < 4 ? n * 3 + 1 : n < 9 ? 8 + n * 4 : 40 + Math.pow(n, 1.55) * 9
    const placedAt = now - ageMin * 60000
    const status: OrderStatus =
      n < 3 ? 'new' : n < 6 ? 'preparing' : n < 8 ? 'ready' : r() < 0.035 ? 'canceled' : 'completed'
    const lineCount = 1 + Math.floor(r() * 4)
    const lines: Order['lines'] = []
    for (let l = 0; l < lineCount; l++) {
      const it = pick(weighted)
      const ex = lines.find((x) => x.name === it.name)
      if (ex) ex.qty++
      else lines.push({ name: it.name, qty: 1 + (r() < 0.2 ? 1 : 0), price: it.price, note: pick(NOTES) })
    }
    const subtotal = +lines.reduce((s, l) => s + l.qty * l.price, 0).toFixed(2)
    const tax = +(subtotal * 0.1075).toFixed(2)
    const provider = pick(['website', 'doordash', 'doordash', 'ubereats', 'ubereats', 'grubhub'])
    const type = provider === 'website' && r() < 0.6 ? 'Pickup' : r() < 0.15 ? 'Pickup' : 'Delivery'
    const tip = type === 'Delivery' ? +(subtotal * (0.1 + r() * 0.1)).toFixed(2) : 0
    orders.push({
      id: `o${n}`,
      number: (provider === 'website' ? '#' : provider === 'doordash' ? 'DD-' : provider === 'ubereats' ? 'UE-' : 'GH-') +
        (8243 - n).toString() + (provider === 'website' ? '' : String.fromCharCode(65 + (n % 26))),
      provider,
      customer: pick(NAMES),
      phone: `(510) 555-${String(1000 + Math.floor(r() * 8999)).slice(0, 4)}`,
      type,
      status,
      placedAt,
      lines,
      subtotal,
      tax,
      tip,
      total: +(subtotal + tax + tip).toFixed(2),
      courier: type === 'Delivery' ? pick(COURIERS) : undefined,
    })
  }
  return orders
}

export function generateChargebacks(orders: Order[]): Chargeback[] {
  const r = rng(7)
  return orders
    .filter((o) => o.provider !== 'website' && o.status === 'completed')
    .filter(() => r() < 0.08)
    .map((o, i) => ({
      id: `cb${i}`,
      orderNumber: o.number,
      provider: o.provider,
      date: o.placedAt + 86400000,
      amount: +(o.lines[0].price * (r() < 0.5 ? 1 : 0.5)).toFixed(2),
      reason: CHARGEBACK_REASONS[Math.floor(r() * CHARGEBACK_REASONS.length)],
      status: i < 3 ? 'Open' : (['Disputed', 'Won', 'Lost', 'Won'] as const)[Math.floor(r() * 4)],
    }))
}

export const providerName = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id
export const providerColor = (id: string) => PROVIDERS.find((p) => p.id === id)?.color ?? '#999'

export function timeAgo(t: number) {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}
