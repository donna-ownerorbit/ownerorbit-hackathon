import { useRef, useState } from 'react'
import { Icon, BrandMark } from '../icons'
import { PROVIDERS, STATUS_META, UNITS, fmt, type Item, type Status } from '../data'
import { useStore } from '../store'
import { Dialog, MenuItem, Popover, Radio, SelectField, Spinner, Switch, TextField, Checkbox } from '../ui'

type Draft = {
  name: string; description: string; price: string; tax: string; image?: string
  sizes: { id: string; name: string; price: string }[]
  sku: string; unit: string; stock: string; barcodes: string[]; trackInventory: boolean; modifierGroupIds: string[]
}

const toDraft = (i: Item): Draft => ({
  name: i.name, description: i.description, price: i.price.toFixed(2), tax: i.tax, image: i.image,
  sizes: i.sizes.map((s) => ({ ...s, price: s.price.toFixed(2) })),
  sku: i.sku, unit: i.unit, stock: String(i.stock), barcodes: i.barcodes, trackInventory: i.trackInventory,
  modifierGroupIds: i.modifierGroupIds,
})

// Local description writer. Swap for a real LLM call (e.g. AI Gateway) later.
function writeDescription(name: string, category: string) {
  const n = name.toLowerCase()
  const bits: string[] = []
  if (/kabab|kebab|chop|grill/.test(n)) bits.push('flame-grilled over open charcoal and', 'marinated overnight in our house blend of garlic, saffron and warm spices')
  else if (/wrap/.test(n)) bits.push('rolled tight in warm lavash with', 'crisp lettuce, tomato, pickles and a generous drizzle of garlic sauce')
  else if (/burger/.test(n)) bits.push('a juicy halal patty stacked on a toasted brioche bun with', 'fresh lettuce, tomato, onion and our signature flame sauce')
  else if (/falafel/.test(n)) bits.push('hand-formed from chickpeas, fresh herbs and cumin,', 'fried golden-crisp outside and fluffy inside')
  else if (/fries|rings/.test(n)) bits.push('cut and fried to order,', 'perfectly crisp and lightly salted')
  else if (/hummus|ganoush|dolma/.test(n)) bits.push('made fresh daily with', 'extra-virgin olive oil, lemon and a touch of tahini')
  else if (/platter/.test(n)) bits.push('a hearty plate piled high and', 'served with rice, salad, hummus and warm pita')
  else bits.push('prepared fresh to order with', 'quality ingredients and bold Mediterranean flavor')
  const openers = ['A crowd favorite', 'Our take on a classic', 'Made the Falafel Flare way']
  const opener = openers[name.length % openers.length]
  return `${opener}: ${name} — ${bits[0]} ${bits[1]}.${category === 'Entrees' ? ' Comes with hummus or special sauce, salad, pita & rice.' : ''}`
}

export function ItemDetail({ item, onClose }: { item: Item; onClose: () => void }) {
  const { categories, updateItem, deleteItem, addItem, toast, modifierGroups } = useStore()
  const cat = categories.find((c) => c.id === item.categoryId)
  const [d, setD] = useState<Draft>(() => toDraft(item))
  const [aiBusy, setAiBusy] = useState(false)
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [availOpen, setAvailOpen] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [barcodeInput, setBarcodeInput] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const original = toDraft(item)
  const dirty = JSON.stringify(original) !== JSON.stringify(d)
  const priceNum = parseFloat(d.price)
  const valid = d.name.trim().length > 0 && !Number.isNaN(priceNum) && priceNum >= 0
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))

  const save = () => {
    updateItem(item.id, {
      name: d.name.trim(), description: d.description, price: +priceNum.toFixed(2), tax: d.tax, image: d.image,
      sizes: d.sizes.filter((s) => s.name.trim()).map((s) => ({ id: s.id, name: s.name.trim(), price: +(parseFloat(s.price) || 0).toFixed(2) })),
      sku: d.sku, unit: d.unit, stock: parseInt(d.stock) || 0, barcodes: d.barcodes, trackInventory: d.trackInventory,
      modifierGroupIds: d.modifierGroupIds,
    })
    toast(`${d.name} updated`)
  }

  const generate = () => {
    setAiBusy(true)
    const text = writeDescription(d.name || item.name, cat?.name ?? '')
    set('description', '')
    let i = 0
    const t = setInterval(() => {
      i += 3
      setD((x) => ({ ...x, description: text.slice(0, i) }))
      if (i >= text.length) { clearInterval(t); setAiBusy(false) }
    }, 16)
  }

  const onFile = (f?: File) => {
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        const s = Math.min(img.width, img.height)
        c.width = c.height = Math.min(480, s)
        c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, c.width, c.height)
        set('image', c.toDataURL('image/jpeg', 0.85))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(f)
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="icon-btn" onClick={onClose} aria-label="Back"><Icon name="arrowBack" size={26} color="#666" /></button>
        <div className="crumbs">
          <span className="crumb-sep">/</span>
          <span className="crumb-muted">{cat?.name}</span>
          <span className="crumb-sep">/</span>
          <span className="crumb-current">{item.name}</span>
        </div>
        <span className="link-chip" title={`Linked to ${cat?.links ?? 0} providers`}><Icon name="link" size={22} color="#555" />{cat?.links ?? 0}</span>
        <span style={{ flex: 1 }} />
        <button ref={setMoreAnchor} className="icon-btn" onClick={() => setMoreOpen((o) => !o)} aria-label="More"><Icon name="moreVert" size={26} color="#666" /></button>
        <Popover anchor={moreAnchor} open={moreOpen} onClose={() => setMoreOpen(false)} align="right" width={200}>
          <MenuItem icon={<Icon name="copy" size={18} />} onClick={() => {
            const id = item.id + '-copy-' + Date.now().toString(36)
            addItem({ ...item, id, name: item.name + ' (Copy)', orders30d: 0 })
            setMoreOpen(false)
            toast(`Duplicated ${item.name}`)
          }}>Duplicate</MenuItem>
          <MenuItem icon={<Icon name="open" size={18} />} onClick={() => { setMoreOpen(false); toast('Preview opened on your ordering website', 'info') }}>View on website</MenuItem>
          <MenuItem danger icon={<Icon name="delete" size={18} color="#e5483b" />} onClick={() => { setMoreOpen(false); setConfirmDelete(true) }}>Delete item</MenuItem>
        </Popover>
      </div>

      <div className="detail-scroll">
        <TextField label="Name" value={d.name} onChange={(v) => set('name', v)} />

        <div className="field-title">Photo</div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        {d.image ? (
          <div className="photo">
            <img src={d.image} alt={d.name} onClick={() => fileRef.current?.click()} />
            <button className="photo-del" onClick={() => set('image', undefined)} aria-label="Remove photo"><Icon name="delete" size={22} color="#fff" /></button>
          </div>
        ) : (
          <button className="photo-drop" onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]) }}>
            <Icon name="upload" size={30} color="#7d8899" />
            <span>Upload photo</span>
            <small>Drag & drop or click · JPG, PNG</small>
          </button>
        )}

        <div className="ai-row">
          <button className="btn btn-ai" onClick={generate} disabled={aiBusy}>
            {aiBusy ? 'Generating…' : 'Generate with AI'}
            {aiBusy ? <Spinner color="#111" size={22} /> : <BrandMark size={30} />}
          </button>
        </div>

        <TextField label="Description (optional)" value={d.description} onChange={(v) => set('description', v)} multiline rows={4} />

        <div className="field-title strong">Base Price</div>
        <TextField label="Price" value={d.price} onChange={(v) => set('price', v.replace(/[^0-9.]/g, ''))} prefix="$" inputMode="decimal"
          style={{ maxWidth: 360 }}
          suffix={<button className="icon-btn" onClick={() => setPriceOpen(true)} aria-label="Price per provider"><Icon name="gear" size={22} color="#333" /></button>} />

        {d.sizes.map((s, idx) => (
          <div key={s.id} className="size-row">
            <TextField label="Size name" value={s.name} onChange={(v) => set('sizes', d.sizes.map((x, j) => (j === idx ? { ...x, name: v } : x)))} />
            <TextField label="Price" value={s.price} prefix="$" inputMode="decimal" style={{ maxWidth: 160 }}
              onChange={(v) => set('sizes', d.sizes.map((x, j) => (j === idx ? { ...x, price: v.replace(/[^0-9.]/g, '') } : x)))} />
            <button className="icon-btn" onClick={() => set('sizes', d.sizes.filter((_, j) => j !== idx))} aria-label="Remove size">
              <Icon name="delete" size={22} color="#888" />
            </button>
          </div>
        ))}
        <button className="btn btn-text dark add-size" onClick={() => set('sizes', [...d.sizes, { id: 's' + Date.now(), name: '', price: d.price }])}>
          <Icon name="add" size={20} /> Add Size
        </button>

        <div className="field-title strong">Item tax</div>
        <div className="tax-row">
          <TextField label="Tax" value={d.tax} onChange={(v) => set('tax', v.replace(/[^0-9.]/g, ''))} placeholder="%" style={{ width: 90, flex: 'none' }} inputMode="decimal" />
          <p>*Based on your location, your store is responsible for collecting and remitting all taxes. If you don’t specify a tax rate, this item will be taxed using your store’s tax rate.</p>
        </div>

        <div className="field-title strong">Modifier groups</div>
        <div className="chips-wrap">
          {modifierGroups.map((g) => {
            const on = d.modifierGroupIds.includes(g.id)
            return (
              <button key={g.id} className={`mod-chip ${on ? 'on' : ''}`}
                onClick={() => set('modifierGroupIds', on ? d.modifierGroupIds.filter((x) => x !== g.id) : [...d.modifierGroupIds, g.id])}>
                {on && <Icon name="check" size={16} />}{g.name}
              </button>
            )
          })}
        </div>

        <h3 className="section-h">Inventory Information</h3>
        <div className="grid2">
          <TextField label="SKU" value={d.sku} onChange={(v) => set('sku', v)} />
          <SelectField label="Unit of Measure" value={d.unit} options={UNITS} onChange={(v) => set('unit', v)} />
        </div>
        <TextField label="Stock Quantity" value={d.stock} onChange={(v) => set('stock', v.replace(/[^0-9-]/g, ''))} disabled={!d.trackInventory} />
        <div className="tf barcode-field">
          <fieldset aria-hidden><legend><span>Barcodes</span></legend></fieldset>
          <label className="tf-label">Barcodes</label>
          <div className="tf-row chips">
            {d.barcodes.map((b) => (
              <span key={b} className="chip">{b}
                <button onClick={() => set('barcodes', d.barcodes.filter((x) => x !== b))} aria-label={`Remove ${b}`}><Icon name="cancel" size={22} color="#b5b5bd" /></button>
              </span>
            ))}
            <input value={barcodeInput} onChange={(e) => setBarcodeInput(e.target.value)} placeholder={d.barcodes.length ? '' : 'Scan or type, then Enter'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && barcodeInput.trim()) {
                  e.preventDefault()
                  if (!d.barcodes.includes(barcodeInput.trim())) set('barcodes', [...d.barcodes, barcodeInput.trim()])
                  setBarcodeInput('')
                } else if (e.key === 'Backspace' && !barcodeInput && d.barcodes.length) set('barcodes', d.barcodes.slice(0, -1))
              }} />
          </div>
        </div>
        <Switch checked={d.trackInventory} onChange={(v) => set('trackInventory', v)} label="Track Inventory" />
        <div className="inv-divider" />
      </div>

      <div className="detail-foot">
        <button className="btn btn-contained" disabled={!dirty || !valid} onClick={save}>Update</button>
        <button className="btn btn-text dark" onClick={() => (dirty ? setD(original) : onClose())}>Cancel</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-avail btn-raised" onClick={() => setAvailOpen(true)}>Update availability</button>
      </div>

      <AvailabilityDialog open={availOpen} onClose={() => setAvailOpen(false)} item={item} />
      <PriceDialog open={priceOpen} onClose={() => setPriceOpen(false)} base={priceNum || 0} />
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete item?" width={420} actions={<>
        <button className="btn btn-text" onClick={() => setConfirmDelete(false)}>Cancel</button>
        <button className="btn btn-danger" onClick={() => { deleteItem(item.id); toast(`${item.name} deleted`, 'info'); onClose() }}>Delete</button>
      </>}>
        <p className="dialog-text"><b>{item.name}</b> will be removed from your menu and from all {cat?.links} linked providers on the next sync.</p>
      </Dialog>
    </div>
  )
}

function AvailabilityDialog({ open, onClose, item }: { open: boolean; onClose: () => void; item: Item }) {
  const { updateItem, toast } = useStore()
  const [status, setStatus] = useState<Status>(item.status)
  const [prov, setProv] = useState<Record<string, boolean>>(Object.fromEntries(PROVIDERS.map((p) => [p.id, true])))
  return (
    <Dialog open={open} onClose={onClose} title={`Availability · ${item.name}`} actions={<>
      <button className="btn btn-text" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={() => {
        updateItem(item.id, { status })
        const n = Object.values(prov).filter(Boolean).length
        toast(`${item.name}: ${STATUS_META[status].label} on ${n} provider${n === 1 ? '' : 's'}`)
        onClose()
      }}>Apply</button>
    </>}>
      <div className="stack">
        {(Object.keys(STATUS_META) as Status[]).map((s) => (
          <Radio key={s} checked={status === s} onChange={() => setStatus(s)}
            label={<span className="row-center"><span className="sdot" style={{ background: STATUS_META[s].color }} />{STATUS_META[s].label}</span>}
            sub={s === 'sold_out_today' ? 'Automatically back in stock tomorrow at opening' : s === 'hidden' ? 'Removed from all menus until you show it again' : undefined} />
        ))}
        <div className="section-label">Apply to</div>
        {PROVIDERS.map((p) => (
          <Checkbox key={p.id} checked={prov[p.id]} onChange={(v) => setProv({ ...prov, [p.id]: v })} label={p.name} />
        ))}
      </div>
    </Dialog>
  )
}

function PriceDialog({ open, onClose, base }: { open: boolean; onClose: () => void; base: number }) {
  const { toast } = useStore()
  const [markup, setMarkup] = useState<Record<string, string>>({ website: '0', doordash: '15', ubereats: '15', grubhub: '12' })
  return (
    <Dialog open={open} onClose={onClose} title="Price by provider" actions={<>
      <button className="btn btn-text" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={() => { onClose(); toast('Provider pricing saved') }}>Save</button>
    </>}>
      <table className="simple-table">
        <thead><tr><th>Provider</th><th>Markup</th><th style={{ textAlign: 'right' }}>Customer price</th></tr></thead>
        <tbody>
          {PROVIDERS.map((p) => {
            const m = parseFloat(markup[p.id]) || 0
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td><input className="mini-input" value={markup[p.id]} onChange={(e) => setMarkup({ ...markup, [p.id]: e.target.value.replace(/[^0-9.]/g, '') })} /> %</td>
                <td style={{ textAlign: 'right', fontWeight: 500 }}>{fmt(m > 0 ? Math.ceil(base * (1 + m / 100)) - 0.01 : base)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Dialog>
  )
}
