import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { buildSeed, MODIFIER_GROUPS, STORES, type Category, type Item, type ModifierGroup } from './data'
import { generateChargebacks, generateOrders, type Chargeback, type Order, type OrderStatus } from './orders'

// Local cache, used only when the database API is unreachable.
const KEY = 'orderdesk:v2'

interface Persisted {
  categories: Category[]
  items: Item[]
  modifierGroups: ModifierGroup[]
  orders: Order[]
  storeId: string
  accepting: boolean
  pausedUntil: number | null
  menuSyncedAt: number
}

export type SyncMode = 'loading' | 'db' | 'local'

function seedState(): Persisted {
  const seed = buildSeed()
  return {
    ...seed,
    modifierGroups: MODIFIER_GROUPS,
    orders: generateOrders(seed.items),
    storeId: STORES[0].id,
    accepting: true,
    pausedUntil: null,
    menuSyncedAt: Date.now() - 1000 * 60 * 60 * 26,
  }
}

function loadLocal(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return seedState()
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json as T
}

interface Toast { id: number; message: string; tone?: 'success' | 'info' | 'error' }

interface Ctx extends Persisted {
  mode: SyncMode
  dbName: string | null
  chargebacks: Chargeback[]
  updateItem: (id: string, patch: Partial<Item>) => void
  addItem: (item: Item) => void
  deleteItem: (id: string) => void
  updateCategory: (id: string, patch: Partial<Category>) => void
  addCategory: (c: Category) => void
  deleteCategory: (id: string) => void
  moveCategory: (id: string, dir: -1 | 1) => void
  saveModifierGroup: (g: ModifierGroup) => void
  deleteModifierGroup: (id: string) => void
  setStore: (id: string) => void
  setAccepting: (on: boolean, pauseMinutes?: number) => void
  setOrderStatus: (id: string, s: OrderStatus) => void
  markSynced: () => void
  reload: () => void
  toast: (message: string, tone?: Toast['tone']) => void
  toasts: Toast[]
}

const StoreCtx = createContext<Ctx | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(loadLocal)
  const [mode, setMode] = useState<SyncMode>('loading')
  const [dbName, setDbName] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const tid = useRef(0)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const toast = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = ++tid.current
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])

  const fetchState = useCallback(async () => {
    try {
      const s = await api<{
        restaurant: { storeId: string; accepting: boolean; pausedUntil: number | null; menuSyncedAt: number }
        categories: Category[]; items: Item[]; modifierGroups: ModifierGroup[]; orders: Order[]; database: string
      }>('GET', 'state')
      setState({
        categories: s.categories, items: s.items, modifierGroups: s.modifierGroups, orders: s.orders,
        storeId: s.restaurant.storeId ?? STORES[0].id, accepting: s.restaurant.accepting ?? true,
        pausedUntil: s.restaurant.pausedUntil ?? null, menuSyncedAt: s.restaurant.menuSyncedAt ?? Date.now(),
      })
      setDbName(s.database)
      setMode('db')
    } catch (e) {
      console.warn('[store] database unavailable, using local data:', (e as Error).message)
      setMode('local')
    }
  }, [])

  useEffect(() => { fetchState() }, [fetchState])

  // Only cache locally when we are not backed by the database.
  useEffect(() => {
    if (mode !== 'local') return
    try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* quota */ }
  }, [state, mode])

  /** Apply optimistically, persist to the DB, and resync from the DB if the write fails. */
  const write = useCallback((apply: (s: Persisted) => Persisted, method?: string, path?: string, body?: unknown) => {
    setState(apply)
    if (modeRef.current !== 'db' || !method || !path) return
    api(method, path, body).catch((e: Error) => {
      toast(`Couldn't save: ${e.message}`, 'error')
      fetchState()
    })
  }, [toast, fetchState])

  const restaurantPatch = (patch: Partial<Persisted>) => write((s) => ({ ...s, ...patch }), 'PATCH', 'restaurant', patch)

  useEffect(() => {
    if (!state.pausedUntil) return
    const ms = state.pausedUntil - Date.now()
    const t = setTimeout(() => restaurantPatch({ accepting: true, pausedUntil: null }), Math.max(0, ms))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pausedUntil])

  const chargebacks = useMemo(() => generateChargebacks(state.orders), [state.orders])

  const value: Ctx = {
    ...state,
    mode,
    dbName,
    chargebacks,
    toasts,
    toast,
    updateItem: (id, patch) =>
      write((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }), 'PATCH', `items/${id}`,
        'image' in patch && patch.image === undefined ? { ...patch, image: null } : patch),
    addItem: (item) => write((s) => ({ ...s, items: [...s.items, item] }), 'POST', 'items', item),
    deleteItem: (id) => write((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }), 'DELETE', `items/${id}`),
    updateCategory: (id, patch) =>
      write((s) => ({ ...s, categories: s.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), 'PATCH', `categories/${id}`, patch),
    addCategory: (c) => write((s) => ({ ...s, categories: [...s.categories, c] }), 'POST', 'categories', c),
    deleteCategory: (id) =>
      write((s) => ({ ...s, categories: s.categories.filter((c) => c.id !== id), items: s.items.filter((i) => i.categoryId !== id) }), 'DELETE', `categories/${id}`),
    moveCategory: (id, dir) => {
      const a = [...state.categories]
      const i = a.findIndex((c) => c.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= a.length) return
      ;[a[i], a[j]] = [a[j], a[i]]
      write((s) => ({ ...s, categories: a }), 'PUT', 'categories/order', { ids: a.map((c) => c.id) })
    },
    saveModifierGroup: (g) =>
      write((s) => ({
        ...s,
        modifierGroups: s.modifierGroups.some((x) => x.id === g.id) ? s.modifierGroups.map((x) => (x.id === g.id ? g : x)) : [...s.modifierGroups, g],
      }), 'PUT', `modifier-groups/${g.id}`, g),
    deleteModifierGroup: (id) => write((s) => ({ ...s, modifierGroups: s.modifierGroups.filter((g) => g.id !== id) }), 'DELETE', `modifier-groups/${id}`),
    setStore: (id) => restaurantPatch({ storeId: id }),
    setAccepting: (on, pauseMinutes) =>
      restaurantPatch({ accepting: on, pausedUntil: !on && pauseMinutes ? Date.now() + pauseMinutes * 60000 : null }),
    setOrderStatus: (id, st) =>
      write((s) => ({ ...s, orders: s.orders.map((o) => (o.id === id ? { ...o, status: st } : o)) }), 'PATCH', `orders/${id}`, { status: st }),
    markSynced: () => restaurantPatch({ menuSyncedAt: Date.now() }),
    reload: () => {
      if (mode === 'db') { fetchState(); return }
      try { localStorage.removeItem(KEY) } catch { /* ignore */ }
      setState(seedState())
    },
  }

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export function useStore() {
  const c = useContext(StoreCtx)
  if (!c) throw new Error('useStore outside provider')
  return c
}

export function useCurrentStore() {
  const { storeId } = useStore()
  return STORES.find((s) => s.id === storeId) ?? STORES[0]
}
