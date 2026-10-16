import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { fmt, PROVIDERS, STORES } from '../data'
import { api, useCurrentStore, useStore } from '../store'
import { Dialog, ProviderBadge, SelectField, Switch, TextField } from '../ui'
import { PageHeader } from './HomePage'

export function ProvidersPage() {
  const { toast, orders } = useStore()
  const [on, setOn] = useState<Record<string, boolean>>({ website: true, doordash: true, ubereats: true, grubhub: true })
  const extra = [{ id: 'caviar', name: 'Caviar' }, { id: 'postmates', name: 'Postmates' }, { id: 'ezcater', name: 'ezCater' }]
  return (
    <div className="page">
      <PageHeader title="Providers" sub="Delivery marketplaces connected to your menu and order queue" />
      <div className="provider-grid">
        {PROVIDERS.map((p) => {
          const n = orders.filter((o) => o.provider === p.id).length
          return (
            <div key={p.id} className="card provider-card">
              <div className="row-center gap12">
                <ProviderBadge id={p.id} size={44} />
                <div><b className="prov-name">{p.name}</b><div className="muted small">{on[p.id] ? 'Connected · menu synced' : 'Paused'}</div></div>
                <span style={{ flex: 1 }} />
                <Switch checked={on[p.id]} onChange={(v) => { setOn({ ...on, [p.id]: v }); toast(`${p.name} ${v ? 'resumed' : 'paused'}`, 'info') }} />
              </div>
              <div className="prov-stats">
                <div><span className="muted small">Orders (30d)</span><b>{n}</b></div>
                <div><span className="muted small">Commission</span><b>{p.id === 'website' ? '0%' : p.id === 'grubhub' ? '20%' : '25%'}</b></div>
                <div><span className="muted small">Store ID</span><b className="mono">{p.id.slice(0, 2).toUpperCase()}-{(48213 + p.name.length * 37)}</b></div>
              </div>
            </div>
          )
        })}
      </div>
      <h2 className="sub-h">Available integrations</h2>
      <div className="provider-grid">
        {extra.map((e) => (
          <div key={e.id} className="card provider-card dashed">
            <div className="row-center gap12">
              <span className="pbadge" style={{ width: 44, height: 44, background: '#cfd4dc', fontSize: 20 }}>{e.name[0]}</span>
              <b className="prov-name">{e.name}</b>
              <span style={{ flex: 1 }} />
              <button className="btn btn-outlined-blue small" onClick={() => toast(`Connection request sent to ${e.name}`, 'info')}>Connect</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function WebsitePage() {
  const { items, categories, toast } = useStore()
  const store = useCurrentStore()
  const [color, setColor] = useState('#f28c28')
  const [headline, setHeadline] = useState('Flame-grilled Mediterranean in Hayward')
  const [pickup, setPickup] = useState(true)
  const [delivery, setDelivery] = useState(true)
  const featured = items.filter((i) => i.image).slice(0, 4)
  const [pages, setPages] = useState<{ slug: string; title: string; version: number; published: boolean; updatedAt: string; updatedBy: string }[] | null>(null)
  useEffect(() => { api<{ pages: NonNullable<typeof pages> }>('GET', 'pages').then((r) => setPages(r.pages), () => setPages([])) }, [])
  return (
    <div className="page">
      <PageHeader title="Website" sub="Commission-free online ordering at falafelflare.com">
        <button className="btn btn-primary" onClick={() => toast('Website published')}>Publish changes</button>
      </PageHeader>
      <div className="website-layout">
        <div className="card pad stack">
          <h2 className="card-title">Customize</h2>
          <TextField label="Headline" value={headline} onChange={setHeadline} />
          <div className="row-center gap12">
            <span className="field-title" style={{ margin: 0 }}>Brand color</span>
            {['#f28c28', '#e5483b', '#457df1', '#2e8b2e', '#111111'].map((c) => (
              <button key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
          <Switch checked={pickup} onChange={setPickup} label="Offer pickup" />
          <Switch checked={delivery} onChange={setDelivery} label="Offer delivery (via Delivery Service)" />
        </div>
        <div className="card pad stack site-pages">
          <h2 className="card-title">Published pages</h2>
          {pages === null ? <span className="muted">Loading…</span> : !pages.length ? <span className="muted">No pages yet. Text Donna "make us a catering page".</span> : pages.map((p) => (
            <a key={p.slug} className="site-page-row" href={`/p/${p.slug}`} target="_blank" rel="noreferrer">
              <b>{p.title}</b>
              <span className="muted">/p/{p.slug} · v{p.version}{p.published ? '' : ' · unpublished'} · {p.updatedBy}</span>
            </a>
          ))}
        </div>
        <div className="card site-preview">
          <div className="browser-bar"><span /><span /><span /><div className="url">falafelflare.com</div></div>
          <div className="site-hero" style={{ background: `linear-gradient(135deg, #1a1a1a, #2b2b2b)` }}>
            <div className="site-brand" style={{ color }}>Falafel Flare</div>
            <h3>{headline}</h3>
            <p>{store.address}</p>
            <div className="row-center gap8">
              {pickup && <span className="site-btn" style={{ background: color }}>Order pickup</span>}
              {delivery && <span className="site-btn ghost">Delivery</span>}
            </div>
          </div>
          <div className="site-body">
            <div className="site-cats">{categories.map((c) => <span key={c.id}>{c.name}</span>)}</div>
            <div className="site-items">
              {featured.map((i) => (
                <div key={i.id} className="site-item">
                  <img src={i.image} alt="" />
                  <b>{i.name}</b>
                  <span style={{ color }}>{fmt(i.price)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function DeliveryPage() {
  const { toast } = useStore()
  const [radius, setRadius] = useState('5')
  const [fee, setFee] = useState('3.99')
  const [min, setMin] = useState('15')
  const [fleet, setFleet] = useState('dd-drive')
  return (
    <div className="page">
      <PageHeader title="Delivery Service" sub="On-demand couriers for orders placed on your own website">
        <button className="btn btn-primary" onClick={() => toast('Delivery settings saved')}>Save</button>
      </PageHeader>
      <div className="home-grid">
        <div className="card pad stack">
          <h2 className="card-title">Courier network</h2>
          <SelectField label="Fleet" value={fleet} onChange={setFleet} options={[
            { value: 'dd-drive', label: 'DoorDash Drive' }, { value: 'uber-direct', label: 'Uber Direct' }, { value: 'own', label: 'In-house drivers' },
          ]} />
          <div className="grid2">
            <TextField label="Delivery radius" value={radius} onChange={setRadius} suffix="mi" inputMode="decimal" />
            <TextField label="Customer fee" value={fee} onChange={setFee} prefix="$" inputMode="decimal" />
          </div>
          <TextField label="Order minimum" value={min} onChange={setMin} prefix="$" inputMode="decimal" />
        </div>
        <div className="card pad">
          <h2 className="card-title">Coverage</h2>
          <div className="map">
            <div className="map-ring" style={{ width: `${Math.min(95, +radius * 14 || 10)}%`, paddingBottom: `${Math.min(95, +radius * 14 || 10)}%` }} />
            <div className="map-pin"><Icon name="pin" size={34} color="#e5483b" /></div>
            <span className="map-label">{radius || 0} mi · ~{Math.round((+radius || 0) ** 2 * 3.1 * 1900).toLocaleString()} households</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { toast, storeId, setStore, reload, mode } = useStore()
  const store = STORES.find((s) => s.id === storeId)!
  const [phone, setPhone] = useState('(510) 555-0142')
  const [email, setEmail] = useState('orders@falafelflare.com')
  const [prep, setPrep] = useState('20')
  const [tax, setTax] = useState('10.75')
  const [autoAccept, setAutoAccept] = useState(true)
  const [sound, setSound] = useState(true)
  const [confirmReset, setConfirmReset] = useState(false)
  return (
    <div className="page">
      <PageHeader title="Settings" sub="Store profile, tax and order preferences">
        <button className="btn btn-primary" onClick={() => toast('Settings saved')}>Save</button>
      </PageHeader>
      <div className="home-grid">
        <div className="card pad stack">
          <h2 className="card-title">Store</h2>
          <SelectField label="Location" value={storeId} onChange={setStore} options={STORES.map((s) => ({ value: s.id, label: s.name }))} />
          <TextField label="Address" value={store.address} disabled />
          <div className="grid2">
            <TextField label="Phone" value={phone} onChange={setPhone} />
            <TextField label="Email" value={email} onChange={setEmail} />
          </div>
        </div>
        <div className="card pad stack">
          <h2 className="card-title">Orders</h2>
          <div className="grid2">
            <TextField label="Default prep time" value={prep} onChange={setPrep} suffix="min" inputMode="numeric" />
            <TextField label="Store tax rate" value={tax} onChange={setTax} suffix="%" inputMode="decimal" />
          </div>
          <Switch checked={autoAccept} onChange={setAutoAccept} label="Auto-accept incoming orders" />
          <Switch checked={sound} onChange={setSound} label="Play sound for new orders" />
          <div className="inv-divider" />
          <button className="btn btn-text danger" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmReset(true)}>{mode === 'db' ? 'Reload from database' : 'Reset demo data'}</button>
        </div>
      </div>
      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)} title={mode === 'db' ? 'Reload from database?' : 'Reset demo data?'} width={420} actions={<>
        <button className="btn btn-text" onClick={() => setConfirmReset(false)}>Cancel</button>
        <button className="btn btn-danger" onClick={() => { reload(); setConfirmReset(false); toast(mode === 'db' ? 'Reloaded from database' : 'Demo data reset', 'info') }}>{mode === 'db' ? 'Reload' : 'Reset'}</button>
      </>}>
        <p className="dialog-text">{mode === 'db' ? 'Discards anything on screen and re-reads the menu, orders and settings from MongoDB. Nothing in the database is changed.' : 'Restores the original menu and clears all edits saved in this browser.'}</p>
      </Dialog>
    </div>
  )
}

export function HelpPage() {
  const [open, setOpen] = useState<number | null>(0)
  const faqs = [
    ['How do I mark an item sold out?', 'Open Menu → Overview and use the dot dropdown on the right of any item. “Sold out today” automatically comes back at tomorrow’s opening.'],
    ['Why didn’t my price change show on DoorDash?', 'Changes are pushed when you press “Update provider menus”. Marketplaces usually reflect updates within 5–15 minutes.'],
    ['How do I dispute a chargeback?', 'Go to Chargeback, find the open adjustment and press Dispute. Include as much detail as possible — photos of sealed bags help.'],
    ['Can I pause orders during a rush?', 'Yes. Click the “Accepting” button on the Menu page and choose a pause duration. Orders resume automatically.'],
    ['How do I add a new location?', 'Contact support and we’ll set up the new store and copy your menu over.'],
  ]
  return (
    <div className="page">
      <PageHeader title="Help" sub="Answers, guides and 24/7 support" />
      <div className="home-grid">
        <div className="card pad">
          <h2 className="card-title">Frequently asked</h2>
          <div className="faq">
            {faqs.map(([q, a], i) => (
              <div key={i} className={`faq-item ${open === i ? 'open' : ''}`}>
                <button onClick={() => setOpen(open === i ? null : i)}>{q}<Icon name={open === i ? 'expandLess' : 'expandMore'} /></button>
                {open === i && <p>{a}</p>}
              </div>
            ))}
          </div>
        </div>
        <div className="card pad stack">
          <h2 className="card-title">Contact support</h2>
          <div className="contact"><Icon name="phone" color="#457df1" /><div><b>(888) 555-0199</b><div className="muted small">24/7 restaurant line</div></div></div>
          <div className="contact"><Icon name="chat" color="#457df1" /><div><b>Live chat</b><div className="muted small">Typical reply under 2 minutes</div></div></div>
          <div className="contact"><Icon name="send" color="#457df1" /><div><b>support@example.com</b><div className="muted small">For non-urgent requests</div></div></div>
        </div>
      </div>
    </div>
  )
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export function SchedulePage() {
  const { toast } = useStore()
  const [hours, setHours] = useState(DAYS.map((d) => ({ day: d, open: true, from: '11:00', to: d === 'Friday' || d === 'Saturday' ? '23:00' : '22:00' })))
  const [holiday, setHoliday] = useState(false)
  return (
    <div className="page">
      <PageHeader title="Schedule" sub="Business hours applied to your website and every provider">
        <button className="btn btn-primary" onClick={() => toast('Hours pushed to all providers')}>Save hours</button>
      </PageHeader>
      <div className="card pad">
        <div className="hours">
          {hours.map((h, i) => (
            <div key={h.day} className={`hours-row ${h.open ? '' : 'closed'}`}>
              <b>{h.day}</b>
              <Switch checked={h.open} onChange={(v) => setHours(hours.map((x, j) => (j === i ? { ...x, open: v } : x)))} label={h.open ? 'Open' : 'Closed'} />
              {h.open && (
                <div className="row-center gap8">
                  <input type="time" className="time" value={h.from} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                  <span className="muted">to</span>
                  <input type="time" className="time" value={h.to} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="inv-divider" />
        <Switch checked={holiday} onChange={setHoliday} label="Holiday hours — close all day on Thanksgiving & Christmas" />
      </div>
    </div>
  )
}
