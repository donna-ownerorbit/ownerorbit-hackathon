import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../icons'
import { fmt, STATUS_META, UNITS, type ModifierGroup, type Status } from '../data'
import { useStore } from '../store'
import { Dialog, SelectField, StatusSelect, Switch, TextField } from '../ui'

/* ---------------- Categories ---------------- */
export function CategoriesTab() {
  const { categories, items, moveCategory, updateCategory, deleteCategory, toast } = useStore()
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const cat = categories.find((c) => c.id === editing)
  return (
    <div className="card table-card">
      <div className="table-toolbar">
        <div>
          <h2 className="card-title">Categories</h2>
          <p className="muted">{categories.length} categories · drag order is reflected on every provider</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="add" size={20} />Add category</button>
      </div>
      <table className="data-table">
        <thead><tr><th style={{ width: 70 }}>Order</th><th>Name</th><th>Items</th><th>Price range</th><th>Linked</th><th>Status</th><th /></tr></thead>
        <tbody>
          {categories.map((c, i) => {
            const mine = items.filter((it) => it.categoryId === c.id)
            const prices = mine.map((m) => m.price)
            return (
              <tr key={c.id}>
                <td>
                  <div className="order-btns">
                    <button className="icon-btn sm" disabled={i === 0} onClick={() => moveCategory(c.id, -1)} aria-label="Move up"><Icon name="expandLess" size={20} /></button>
                    <button className="icon-btn sm" disabled={i === categories.length - 1} onClick={() => moveCategory(c.id, 1)} aria-label="Move down"><Icon name="expandMore" size={20} /></button>
                  </div>
                </td>
                <td><div className="strong-cell">{c.name}</div>{c.description && <div className="muted small">{c.description}</div>}</td>
                <td>{mine.length}</td>
                <td>{prices.length ? `${fmt(Math.min(...prices))} – ${fmt(Math.max(...prices))}` : '—'}</td>
                <td><span className="link-chip"><Icon name="link" size={18} color="#555" />{c.links}</span></td>
                <td><StatusSelect value={c.status} onChange={(s) => { updateCategory(c.id, { status: s }); toast(`${c.name}: ${STATUS_META[s].label}`, 'info') }} /></td>
                <td className="row-actions">
                  <button className="icon-btn" onClick={() => setEditing(c.id)} aria-label="Edit"><Icon name="edit" size={20} color="#666" /></button>
                  <button className="icon-btn" onClick={() => setConfirm(c.id)} aria-label="Delete"><Icon name="delete" size={20} color="#666" /></button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {cat && <EditCategoryDialog key={cat.id} id={cat.id} onClose={() => setEditing(null)} />}
      <AddCategoryDialog open={adding} onClose={() => setAdding(false)} />
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title="Delete category?" width={420} actions={<>
        <button className="btn btn-text" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="btn btn-danger" onClick={() => { const c = categories.find((x) => x.id === confirm); deleteCategory(confirm!); setConfirm(null); toast(`${c?.name} deleted`, 'info') }}>Delete</button>
      </>}>
        <p className="dialog-text">This deletes the category and all {items.filter((i) => i.categoryId === confirm).length} items inside it.</p>
      </Dialog>
    </div>
  )
}

function EditCategoryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { categories, updateCategory, toast } = useStore()
  const c = categories.find((x) => x.id === id)!
  const [name, setName] = useState(c.name)
  const [desc, setDesc] = useState(c.description)
  return (
    <Dialog open onClose={onClose} title="Edit category" actions={<>
      <button className="btn btn-text" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={() => { updateCategory(id, { name: name.trim(), description: desc }); toast('Category saved'); onClose() }}>Save</button>
    </>}>
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} autoFocus />
        <TextField label="Description (optional)" value={desc} onChange={setDesc} multiline rows={3} />
      </div>
    </Dialog>
  )
}

export function AddCategoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { addCategory, toast } = useStore()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const close = () => { setName(''); setDesc(''); onClose() }
  return (
    <Dialog open={open} onClose={close} title="Add category" actions={<>
      <button className="btn btn-text" onClick={close}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={() => {
        addCategory({ id: 'cat-' + Date.now().toString(36), name: name.trim(), description: desc, links: 4, status: 'available' })
        toast(`${name.trim()} added`)
        close()
      }}>Add</button>
    </>}>
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} autoFocus />
        <TextField label="Description (optional)" value={desc} onChange={setDesc} multiline rows={3} />
      </div>
    </Dialog>
  )
}

export function AddItemDialog({ open, onClose, defaultCategory, onCreated }: {
  open: boolean; onClose: () => void; defaultCategory?: string; onCreated?: (id: string) => void
}) {
  const { categories, addItem, toast } = useStore()
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [desc, setDesc] = useState('')
  const [catId, setCatId] = useState<string>('')
  const [unit, setUnit] = useState('Piece')
  const cid = catId || defaultCategory || categories[0]?.id
  const close = () => { setName(''); setPrice(''); setDesc(''); setCatId(''); onClose() }
  const p = parseFloat(price)
  return (
    <Dialog open={open} onClose={close} title="Add item" actions={<>
      <button className="btn btn-text" onClick={close}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim() || Number.isNaN(p)} onClick={() => {
        const id = 'item-' + Date.now().toString(36)
        const sku = 'SKU-' + Math.random().toString(16).slice(2, 10).toUpperCase()
        addItem({
          id, categoryId: cid, name: name.trim(), description: desc, price: +p.toFixed(2), status: 'available', tax: '', sizes: [],
          sku, unit, stock: 0, barcodes: [sku], trackInventory: false, modifierGroupIds: [], orders30d: 0, isNew: true,
        })
        toast(`${name.trim()} added`)
        onCreated?.(id)
        close()
      }}>Add item</button>
    </>}>
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} autoFocus />
        <div className="grid2">
          <TextField label="Price" value={price} onChange={(v) => setPrice(v.replace(/[^0-9.]/g, ''))} prefix="$" inputMode="decimal" />
          <SelectField label="Category" value={cid} onChange={setCatId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        </div>
        <SelectField label="Unit of Measure" value={unit} onChange={setUnit} options={UNITS} />
        <TextField label="Description (optional)" value={desc} onChange={setDesc} multiline rows={3} />
      </div>
    </Dialog>
  )
}

/* ---------------- Items ---------------- */
export function ItemsTab() {
  const { items, categories, updateItem } = useStore()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [st, setSt] = useState<'all' | Status>('all')
  const [adding, setAdding] = useState(false)
  const rows = items.filter((i) =>
    (cat === 'all' || i.categoryId === cat) && (st === 'all' || i.status === st) &&
    (!q || (i.name + i.sku).toLowerCase().includes(q.toLowerCase())))
  return (
    <div className="card table-card">
      <div className="table-toolbar">
        <div>
          <h2 className="card-title">Items</h2>
          <p className="muted">{rows.length} of {items.length} items</p>
        </div>
        <div className="toolbar-right">
          <div className="search small">
            <Icon name="search" size={20} color="#333" />
            <input placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <SelectField label="Category" value={cat} onChange={setCat} style={{ width: 170 }}
            options={[{ value: 'all', label: 'All categories' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
          <SelectField label="Status" value={st} onChange={(v) => setSt(v as Status | 'all')} style={{ width: 170 }}
            options={[{ value: 'all', label: 'Any status' }, ...(Object.keys(STATUS_META) as Status[]).map((s) => ({ value: s, label: STATUS_META[s].label }))]} />
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="add" size={20} />Add item</button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table hover">
          <thead><tr><th>Item</th><th>Category</th><th>SKU</th><th>Stock</th><th style={{ textAlign: 'right' }}>Price</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} onClick={() => nav(`/menu/overview?item=${i.id}`)}>
                <td>
                  <div className="row-center gap12">
                    <div className="avatar sm">{i.image ? <img src={i.image} alt="" /> : <Icon name="image" size={18} color="#444" />}</div>
                    <span className="strong-cell">{i.name}</span>
                    {i.isNew && <span className="new-chip">NEW</span>}
                  </div>
                </td>
                <td>{categories.find((c) => c.id === i.categoryId)?.name}</td>
                <td className="mono">{i.sku}</td>
                <td className={i.trackInventory && i.stock < 20 ? 'warn-text' : ''}>{i.trackInventory ? `${i.stock} ${i.unit.toLowerCase()}${Math.abs(i.stock) === 1 ? '' : 's'}` : '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 500 }}>{fmt(i.price)}{i.sizes.length > 0 && <div className="muted small">+{i.sizes.length} size</div>}</td>
                <td onClick={(e) => e.stopPropagation()}><StatusSelect value={i.status} onChange={(s) => updateItem(i.id, { status: s })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AddItemDialog open={adding} onClose={() => setAdding(false)} onCreated={(id) => nav(`/menu/overview?item=${id}`)} />
    </div>
  )
}

/* ---------------- Popular ---------------- */
export function PopularTab() {
  const { items, categories } = useStore()
  const nav = useNavigate()
  const ranked = useMemo(() => [...items].sort((a, b) => b.orders30d - a.orders30d).slice(0, 15), [items])
  const max = ranked[0]?.orders30d || 1
  return (
    <div className="card table-card">
      <div className="table-toolbar">
        <div>
          <h2 className="card-title">Popular items</h2>
          <p className="muted">Top sellers across all providers · last 30 days</p>
        </div>
      </div>
      <div className="popular-list">
        {ranked.map((i, idx) => (
          <button key={i.id} className="popular-row" onClick={() => nav(`/menu/overview?item=${i.id}`)}>
            <span className={`rank ${idx < 3 ? 'top' : ''}`}>{idx + 1}</span>
            <div className="avatar sm">{i.image ? <img src={i.image} alt="" /> : <Icon name="image" size={18} color="#444" />}</div>
            <div className="pop-main">
              <div className="row-center gap8"><span className="strong-cell">{i.name}</span><span className="muted small">{categories.find((c) => c.id === i.categoryId)?.name}</span></div>
              <div className="bar"><span style={{ width: `${(i.orders30d / max) * 100}%` }} /></div>
            </div>
            <div className="pop-stats">
              <b>{i.orders30d}</b><span className="muted small">orders</span>
            </div>
            <div className="pop-stats">
              <b>{fmt(i.orders30d * i.price)}</b><span className="muted small">revenue</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- Modifier groups ---------------- */
export function ModifierGroupsTab() {
  const { modifierGroups, saveModifierGroup, deleteModifierGroup, items, toast } = useStore()
  const [editing, setEditing] = useState<ModifierGroup | null>(null)
  return (
    <div className="card table-card">
      <div className="table-toolbar">
        <div>
          <h2 className="card-title">Modifier groups</h2>
          <p className="muted">Options customers pick when ordering — sauces, proteins, add-ons</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({ id: 'mg-' + Date.now().toString(36), name: '', min: 0, max: 1, required: false, options: [] })}>
          <Icon name="add" size={20} />Add group
        </button>
      </div>
      <div className="mod-grid">
        {modifierGroups.map((g) => {
          const used = items.filter((i) => i.modifierGroupIds.includes(g.id)).length
          return (
            <div key={g.id} className="mod-card" onClick={() => setEditing(g)}>
              <div className="row-center">
                <b className="mod-title">{g.name}</b>
                <span style={{ flex: 1 }} />
                <span className={`pill ${g.required ? 'pill-blue' : ''}`}>{g.required ? 'Required' : 'Optional'}</span>
              </div>
              <div className="muted small">Choose {g.min === g.max ? g.max : `${g.min}–${g.max}`} · used by {used} item{used === 1 ? '' : 's'}</div>
              <ul className="mod-opts">
                {g.options.map((o) => (
                  <li key={o.id}><span>{o.name}</span><span className="muted">{o.price ? '+' + fmt(o.price) : 'Free'}</span></li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
      {editing && (
        <ModifierDialog key={editing.id} group={editing} onClose={() => setEditing(null)}
          onDelete={() => { deleteModifierGroup(editing.id); setEditing(null); toast('Modifier group deleted', 'info') }}
          onSave={(g) => {
            saveModifierGroup(g)
            setEditing(null)
            toast(`${g.name} saved`)
          }} />
      )}
    </div>
  )
}

function ModifierDialog({ group, onClose, onSave, onDelete }: { group: ModifierGroup; onClose: () => void; onSave: (g: ModifierGroup) => void; onDelete: () => void }) {
  const [g, setG] = useState(group)
  const isNew = !group.name
  return (
    <Dialog open onClose={onClose} title={isNew ? 'New modifier group' : 'Edit modifier group'} width={560} actions={<>
      {!isNew && <button className="btn btn-text danger" onClick={onDelete}>Delete</button>}
      <span style={{ flex: 1 }} />
      <button className="btn btn-text" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!g.name.trim()} onClick={() => onSave({ ...g, name: g.name.trim(), options: g.options.filter((o) => o.name.trim()) })}>Save</button>
    </>}>
      <div className="stack">
        <TextField label="Group name" value={g.name} onChange={(v) => setG({ ...g, name: v })} autoFocus={isNew} />
        <div className="grid2">
          <TextField label="Min selections" value={String(g.min)} onChange={(v) => setG({ ...g, min: parseInt(v) || 0 })} inputMode="numeric" />
          <TextField label="Max selections" value={String(g.max)} onChange={(v) => setG({ ...g, max: parseInt(v) || 0 })} inputMode="numeric" />
        </div>
        <Switch checked={g.required} onChange={(v) => setG({ ...g, required: v, min: v ? Math.max(1, g.min) : 0 })} label="Customer must choose" />
        <div className="section-label">Options</div>
        {g.options.map((o, i) => (
          <div key={o.id} className="size-row">
            <TextField label="Option" value={o.name} onChange={(v) => setG({ ...g, options: g.options.map((x, j) => (j === i ? { ...x, name: v } : x)) })} />
            <TextField label="Price" value={String(o.price)} prefix="$" style={{ maxWidth: 140 }} inputMode="decimal"
              onChange={(v) => setG({ ...g, options: g.options.map((x, j) => (j === i ? { ...x, price: parseFloat(v) || 0 } : x)) })} />
            <button className="icon-btn" onClick={() => setG({ ...g, options: g.options.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="delete" size={20} color="#888" /></button>
          </div>
        ))}
        <button className="btn btn-text dark" style={{ alignSelf: 'flex-start' }}
          onClick={() => setG({ ...g, options: [...g.options, { id: 'o' + Date.now(), name: '', price: 0 }] })}>
          <Icon name="add" size={20} />Add option
        </button>
      </div>
    </Dialog>
  )
}
