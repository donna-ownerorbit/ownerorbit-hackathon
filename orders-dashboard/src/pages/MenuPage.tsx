import { useMemo, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '../icons'
import { fmt, PROVIDERS, STORES, type Item } from '../data'
import { useCurrentStore, useStore } from '../store'
import { Dialog, MenuItem, Popover, Radio, Spinner, StatusSelect, TextField, Switch, Checkbox, SelectField } from '../ui'
import { EmptyIllustration } from './Illustration'
import { ItemDetail } from './ItemDetail'
import { CategoriesTab, ItemsTab, PopularTab, ModifierGroupsTab, AddItemDialog, AddCategoryDialog } from './MenuTabs'

export default function MenuPage() {
  return (
    <div className="menu-page">
      <MenuHeader />
      <nav className="tabs">
        <NavLink to="/menu/overview" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>Overview</NavLink>
        <NavLink to="/menu/categories" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>Categories</NavLink>
        <NavLink to="/menu/items" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>Items</NavLink>
        <NavLink to="/menu/popular" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>Popular Items</NavLink>
        <NavLink to="/menu/modifier-groups" className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>Modifier Groups</NavLink>
      </nav>
      <div className="menu-body">
        <Routes>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<Overview />} />
          <Route path="categories" element={<CategoriesTab />} />
          <Route path="items" element={<ItemsTab />} />
          <Route path="popular" element={<PopularTab />} />
          <Route path="modifier-groups" element={<ModifierGroupsTab />} />
        </Routes>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function MenuHeader() {
  const { accepting, setAccepting, pausedUntil, toast, markSynced, menuSyncedAt, setStore, storeId, items, orders } = useStore()
  const store = useCurrentStore()
  const [syncing, setSyncing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [acceptAnchor, setAcceptAnchor] = useState<HTMLButtonElement | null>(null)
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [storeAnchor, setStoreAnchor] = useState<HTMLButtonElement | null>(null)
  const [storeOpen, setStoreOpen] = useState(false)

  const sync = () => {
    setSyncing(true)
    setTimeout(() => {
      setSyncing(false)
      markSynced()
      toast(`Menu pushed to ${PROVIDERS.length} providers · ${items.length} items synced`)
    }, 1600)
  }

  return (
    <header className="menu-header">
      <div className="mh-row1">
        <h1 className="page-title">Menu</h1>
        <button className="btn btn-primary btn-raised" onClick={sync} disabled={syncing} title={`Last synced ${new Date(menuSyncedAt).toLocaleString()}`}>
          {syncing ? <Spinner /> : <Icon name="refresh" size={22} style={{ transform: 'scaleX(-1)' }} />}
          {syncing ? 'Updating…' : 'Update provider menus'}
        </button>
        <button className="btn btn-gear btn-raised" onClick={() => setSettingsOpen(true)} aria-label="Menu settings">
          <Icon name="gear" size={20} color="#333" />
        </button>
      </div>
      <div className="mh-row2">
        <button className="btn btn-outlined-blue" onClick={() => setBatchOpen(true)}>Batch report</button>
        <button ref={setAcceptAnchor} className="btn btn-accepting" onClick={() => setAcceptOpen((o) => !o)}>
          <span className="sdot lg" style={{ background: accepting ? '#2e8b2e' : '#e5483b' }} />
          {accepting ? 'Accepting' : pausedUntil ? `Paused · ${new Date(pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not accepting'}
        </button>
        <button ref={setStoreAnchor} className="btn btn-store" onClick={() => setStoreOpen((o) => !o)}>
          <span className="ellipsis">{store.name} - {store.address.split(',')[0]}</span>
          <Icon name="chevronRight" size={22} color="#666" />
        </button>
      </div>

      <Popover anchor={acceptAnchor} open={acceptOpen} onClose={() => setAcceptOpen(false)} width={260}>
        <div className="pop-heading">Order acceptance</div>
        <MenuItem selected={accepting} icon={<span className="sdot" style={{ background: '#2e8b2e' }} />}
          onClick={() => { setAccepting(true); setAcceptOpen(false); toast('Now accepting orders on all providers') }}>Accepting orders</MenuItem>
        {[15, 30, 60].map((m) => (
          <MenuItem key={m} icon={<Icon name="pause" size={18} color="#f0b130" />}
            onClick={() => { setAccepting(false, m); setAcceptOpen(false); toast(`Orders paused for ${m} minutes`, 'info') }}>Pause for {m} min</MenuItem>
        ))}
        <MenuItem danger icon={<span className="sdot" style={{ background: '#e5483b' }} />}
          onClick={() => { setAccepting(false); setAcceptOpen(false); toast('Stopped accepting orders for the rest of today', 'info') }}>Stop for today</MenuItem>
      </Popover>

      <Popover anchor={storeAnchor} open={storeOpen} onClose={() => setStoreOpen(false)} width={420} align="left">
        <div className="pop-heading">Switch location</div>
        {STORES.map((s) => (
          <MenuItem key={s.id} selected={s.id === storeId} icon={<Icon name="pin" size={20} color="#5f6673" />}
            onClick={() => { setStore(s.id); setStoreOpen(false); toast(`Switched to ${s.name}`, 'info') }}>
            <div className="store-opt"><b>{s.name}</b><span>{s.address}</span></div>
          </MenuItem>
        ))}
      </Popover>

      <MenuSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <BatchReportDialog open={batchOpen} onClose={() => setBatchOpen(false)} itemsCount={items.length} ordersCount={orders.length} />
    </header>
  )
}

function MenuSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, reload, mode } = useStore()
  const [autoSync, setAutoSync] = useState(true)
  const [hideSoldOut, setHideSoldOut] = useState(false)
  const [markup, setMarkup] = useState('15')
  const [providers, setProviders] = useState<Record<string, boolean>>({ website: true, doordash: true, ubereats: true, grubhub: true })
  return (
    <Dialog open={open} onClose={onClose} title="Menu settings" actions={<>
      <button className="btn btn-text" onClick={() => { reload(); onClose(); toast(mode === 'db' ? 'Reloaded from database' : 'Demo data reset', 'info') }}>{mode === 'db' ? 'Reload from database' : 'Reset demo data'}</button>
      <span style={{ flex: 1 }} />
      <button className="btn btn-text" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={() => { onClose(); toast('Menu settings saved') }}>Save</button>
    </>}>
      <div className="stack">
        <Switch checked={autoSync} onChange={setAutoSync} label="Automatically push menu changes to providers" />
        <Switch checked={hideSoldOut} onChange={setHideSoldOut} label="Hide sold out items instead of showing “Sold out”" />
        <div className="field-note">Third-party price markup — offsets marketplace commission on delivery apps.</div>
        <TextField label="Markup" value={markup} onChange={setMarkup} suffix="%" style={{ maxWidth: 160 }} inputMode="decimal" />
        <div className="section-label">Publish menu to</div>
        {PROVIDERS.map((p) => (
          <Checkbox key={p.id} checked={providers[p.id]} onChange={(v) => setProviders({ ...providers, [p.id]: v })} label={p.name} />
        ))}
      </div>
    </Dialog>
  )
}

function BatchReportDialog({ open, onClose, itemsCount, ordersCount }: { open: boolean; onClose: () => void; itemsCount: number; ordersCount: number }) {
  const { toast } = useStore()
  const [range, setRange] = useState('7')
  const [kind, setKind] = useState('sales')
  const [running, setRunning] = useState(false)
  return (
    <Dialog open={open} onClose={onClose} title="Batch report" actions={<>
      <button className="btn btn-text" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={running} onClick={() => {
        setRunning(true)
        setTimeout(() => { setRunning(false); onClose(); toast('Batch report generated — check your email') }, 1200)
      }}>{running ? <Spinner /> : <Icon name="download" size={20} />} Generate</button>
    </>}>
      <div className="stack">
        <SelectField label="Date range" value={range} onChange={setRange} options={[
          { value: '1', label: 'Today' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last quarter' },
        ]} />
        <Radio checked={kind === 'sales'} onChange={() => setKind('sales')} label="Item sales" sub={`Units sold and revenue for all ${itemsCount} items`} />
        <Radio checked={kind === 'availability'} onChange={() => setKind('availability')} label="Availability log" sub="Every time an item was marked sold out or hidden" />
        <Radio checked={kind === 'provider'} onChange={() => setKind('provider')} label="Provider breakdown" sub={`Sales split across providers (${ordersCount} orders)`} />
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */

type SortMode = 'custom' | 'az' | 'za' | 'price-asc' | 'price-desc' | 'popular'
const SORTS: { id: SortMode; label: string }[] = [
  { id: 'custom', label: 'Custom order' },
  { id: 'az', label: 'Name A–Z' },
  { id: 'za', label: 'Name Z–A' },
  { id: 'price-asc', label: 'Price: low to high' },
  { id: 'price-desc', label: 'Price: high to low' },
  { id: 'popular', label: 'Most popular' },
]

function sortItems(items: Item[], mode: SortMode) {
  const a = [...items]
  switch (mode) {
    case 'az': return a.sort((x, y) => x.name.localeCompare(y.name))
    case 'za': return a.sort((x, y) => y.name.localeCompare(x.name))
    case 'price-asc': return a.sort((x, y) => x.price - y.price)
    case 'price-desc': return a.sort((x, y) => y.price - x.price)
    case 'popular': return a.sort((x, y) => y.orders30d - x.orders30d)
    default: return a
  }
}

function Overview() {
  const { categories, items, updateItem, updateCategory, toast } = useStore()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('item')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortMode>('custom')
  const [catSort, setCatSort] = useState<Record<string, SortMode>>({})
  const [addAnchor, setAddAnchor] = useState<HTMLButtonElement | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [sortAnchor, setSortAnchor] = useState<HTMLButtonElement | null>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const [catMenu, setCatMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  const [dialog, setDialog] = useState<null | 'item' | 'category'>(null)
  const [addToCat, setAddToCat] = useState<string | undefined>()
  const navigate = useNavigate()

  const select = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('item', id)
    else p.delete('item')
    setParams(p, { replace: true })
  }

  const needle = q.trim().toLowerCase()
  const groups = useMemo(
    () =>
      categories.map((c) => {
        const mine = items.filter((i) => i.categoryId === c.id)
        const filtered = needle ? mine.filter((i) => (i.name + ' ' + i.description).toLowerCase().includes(needle)) : mine
        return { cat: c, total: mine.length, items: sortItems(filtered, catSort[c.id] ?? sort) }
      }).filter((g) => !needle || g.items.length > 0),
    [categories, items, needle, sort, catSort],
  )

  const selected = items.find((i) => i.id === selectedId)

  return (
    <div className={`overview ${selected ? 'has-selection' : ''}`}>
      <section className="card list-card">
        <div className="toolbar">
          <button ref={setAddAnchor} className="btn btn-gray" onClick={() => setAddOpen((o) => !o)}><Icon name="add" size={24} />Add</button>
          <button ref={setSortAnchor} className="btn btn-gray" onClick={() => setSortOpen((o) => !o)}><Icon name="sort" size={24} />Sort</button>
          <div className="search">
            <Icon name="search" size={24} color="#333" />
            <input placeholder="Type to Search" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear"><Icon name="close" size={18} color="#888" /></button>}
          </div>
        </div>
        <Popover anchor={addAnchor} open={addOpen} onClose={() => setAddOpen(false)} width={200}>
          <MenuItem icon={<Icon name="add" size={20} />} onClick={() => { setAddToCat(undefined); setDialog('item'); setAddOpen(false) }}>Add item</MenuItem>
          <MenuItem icon={<Icon name="orders" size={20} />} onClick={() => { setDialog('category'); setAddOpen(false) }}>Add category</MenuItem>
        </Popover>
        <Popover anchor={sortAnchor} open={sortOpen} onClose={() => setSortOpen(false)} width={220}>
          {SORTS.map((s) => (
            <MenuItem key={s.id} selected={sort === s.id} onClick={() => { setSort(s.id); setCatSort({}); setSortOpen(false) }}>{s.label}</MenuItem>
          ))}
        </Popover>

        <div className="cat-list">
          {groups.length === 0 && (
            <div className="no-results">No items match “{q}”.</div>
          )}
          {groups.map(({ cat, total, items: list }) => {
            const open = !cat.collapsed || !!needle
            return (
              <div key={cat.id} className="cat-group">
                <div className="cat-head">
                  <span className="cat-links" title={`Linked to ${cat.links} providers`}><Icon name="link" size={28} color="#444" />{cat.links}</span>
                  <button className="icon-btn" onClick={() => updateCategory(cat.id, { collapsed: !cat.collapsed })} aria-label="Collapse">
                    <Icon name={open ? 'expandLess' : 'expandMore'} size={26} color="#444" />
                  </button>
                  <span className="cat-name">{cat.name}</span>
                  <span className="cat-count">(Number of items: {total} )</span>
                  <span style={{ flex: 1 }} />
                  <button className="icon-btn" onClick={(e) => setCatMenu({ id: cat.id, el: e.currentTarget })} aria-label="Category options">
                    <Icon name="sort" size={24} color="#9a9a9a" />
                  </button>
                </div>
                {open && (
                  <div className={`cat-items ${cat.status !== 'available' ? 'dim' : ''}`}>
                    {list.map((it) => (
                      <div key={it.id} className={`item-row ${it.id === selectedId ? 'selected' : ''} ${it.status !== 'available' ? 'unavail' : ''}`}
                        onClick={() => select(it.id)}>
                        <span className="item-link" title={`Linked to ${cat.links} providers`}><Icon name="link" size={28} color="#444" /></span>
                        <div className="avatar">
                          {it.image ? <img src={it.image} alt="" /> : <Icon name="image" size={26} color="#444" />}
                        </div>
                        <div className="item-text">
                          <div className="item-name">{it.name}{it.isNew && <span className="new-chip">NEW</span>}</div>
                          {it.description && <div className="item-desc">{it.description}</div>}
                        </div>
                        <div className="item-price">{fmt(it.price)}</div>
                        <StatusSelect value={it.status} onChange={(s) => { updateItem(it.id, { status: s }); toast(`${it.name} marked ${s.replace(/_/g, ' ')}`, 'info') }} />
                      </div>
                    ))}
                    <button className="add-inline" onClick={() => { setAddToCat(cat.id); setDialog('item') }}>
                      <Icon name="add" size={20} /> Add item to {cat.name}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <Popover anchor={catMenu?.el ?? null} open={!!catMenu} onClose={() => setCatMenu(null)} align="right" width={230}>
          <div className="pop-heading">Sort items in category</div>
          {SORTS.map((s) => (
            <MenuItem key={s.id} selected={(catSort[catMenu?.id ?? ''] ?? sort) === s.id}
              onClick={() => { setCatSort({ ...catSort, [catMenu!.id]: s.id }); setCatMenu(null) }}>{s.label}</MenuItem>
          ))}
          <div className="pop-divider" />
          <MenuItem icon={<Icon name="edit" size={18} />} onClick={() => { setCatMenu(null); navigate('/menu/categories') }}>Edit category</MenuItem>
        </Popover>
      </section>

      <section className="card detail-card">
        {selected ? (
          <ItemDetail key={selected.id} item={selected} onClose={() => select(null)} />
        ) : (
          <div className="empty-state">
            <EmptyIllustration />
            <h2>Select an Item from the list for the Review</h2>
            <p>Reduce your busywork and take your menu management to the next level</p>
          </div>
        )}
      </section>

      <AddItemDialog open={dialog === 'item'} defaultCategory={addToCat} onClose={() => setDialog(null)} onCreated={(id) => select(id)} />
      <AddCategoryDialog open={dialog === 'category'} onClose={() => setDialog(null)} />
    </div>
  )
}
