import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../icons'
import { fmt, PROVIDERS } from '../data'
import { useCurrentStore, useStore } from '../store'
import { providerName, timeAgo } from '../orders'
import { ProviderBadge } from '../ui'

export function PageHeader({ title, children, sub }: { title: string; children?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      <div className="page-actions">{children}</div>
    </header>
  )
}

export function Stat({ label, value, delta, icon }: { label: string; value: string; delta?: number; icon: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <div className="card stat">
      <div className="stat-icon"><Icon name={icon} size={22} color="#457df1" /></div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {delta !== undefined && (
        <div className={`stat-delta ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs last week</div>
      )}
    </div>
  )
}

export function HomePage() {
  const { orders, accepting, items } = useStore()
  const store = useCurrentStore()
  const nav = useNavigate()
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
  const today = orders.filter((o) => o.placedAt >= dayStart.getTime() && o.status !== 'canceled')
  const week = orders.filter((o) => o.placedAt >= Date.now() - 7 * 864e5 && o.status !== 'canceled')
  const sales = today.reduce((s, o) => s + o.subtotal, 0)
  const active = orders.filter((o) => ['new', 'preparing', 'ready'].includes(o.status))
  const soldOut = items.filter((i) => i.status !== 'available')

  const hourly = useMemo(() => {
    const h = Array(24).fill(0) as number[]
    week.forEach((o) => { h[new Date(o.placedAt).getHours()] += o.subtotal })
    return h.slice(10, 23)
  }, [week])
  const maxH = Math.max(...hourly, 1)

  const byProvider = PROVIDERS.map((p) => ({ ...p, total: week.filter((o) => o.provider === p.id).reduce((s, o) => s + o.subtotal, 0) }))
  const provTotal = byProvider.reduce((s, p) => s + p.total, 0) || 1

  return (
    <div className="page">
      <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}`}
        sub={<>{store.name} · <span className={accepting ? 'ok-text' : 'warn-text'}>{accepting ? 'Accepting orders' : 'Paused'}</span></>}>
        <button className="btn btn-outlined-blue" onClick={() => nav('/orders')}>View live orders</button>
      </PageHeader>

      <div className="stat-grid">
        <Stat label="Today's sales" value={fmt(sales)} delta={8.4} icon="trending" />
        <Stat label="Orders today" value={String(today.length)} delta={5.1} icon="orders" />
        <Stat label="Avg. ticket" value={fmt(today.length ? sales / today.length : 0)} delta={-1.2} icon="reports" />
        <Stat label="Active orders" value={String(active.length)} icon="bell" />
      </div>

      <div className="home-grid">
        <div className="card pad">
          <div className="card-head"><h2 className="card-title">Sales by hour</h2><span className="muted small">Last 7 days</span></div>
          <div className="bars">
            {hourly.map((v, i) => (
              <div key={i} className="bar-col" title={fmt(v)}>
                <div className="bar-fill" style={{ height: `${(v / maxH) * 100}%` }} />
                <span>{((i + 10) % 12) || 12}{i + 10 < 12 ? 'a' : 'p'}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card pad">
          <div className="card-head"><h2 className="card-title">Sales by provider</h2><span className="muted small">Last 7 days</span></div>
          <div className="stacked">
            {byProvider.map((p) => <span key={p.id} style={{ width: `${(p.total / provTotal) * 100}%`, background: p.color }} title={p.name} />)}
          </div>
          <ul className="legend">
            {byProvider.map((p) => (
              <li key={p.id}><ProviderBadge id={p.id} size={22} /><span>{p.name}</span><b>{fmt(p.total)}</b><span className="muted small">{((p.total / provTotal) * 100).toFixed(0)}%</span></li>
            ))}
          </ul>
        </div>

        <div className="card pad">
          <div className="card-head"><h2 className="card-title">Live orders</h2><button className="btn btn-text small" onClick={() => nav('/orders')}>See all</button></div>
          <ul className="mini-orders">
            {active.slice(0, 6).map((o) => (
              <li key={o.id} onClick={() => nav(`/orders?o=${o.id}`)}>
                <ProviderBadge id={o.provider} />
                <div><b>{o.number}</b> · {o.customer}<div className="muted small">{providerName(o.provider)} · {timeAgo(o.placedAt)}</div></div>
                <span className={`status-pill s-${o.status}`}>{o.status}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card pad">
          <div className="card-head"><h2 className="card-title">Needs attention</h2></div>
          <ul className="attention">
            {soldOut.length > 0 && <li onClick={() => nav('/menu/items')}><Icon name="warning" size={20} color="#f0b130" />{soldOut.length} item{soldOut.length > 1 ? 's are' : ' is'} unavailable on your menu</li>}
            {items.filter((i) => i.trackInventory && i.stock < 0).map((i) => (
              <li key={i.id} onClick={() => nav(`/menu/overview?item=${i.id}`)}><Icon name="warning" size={20} color="#e5483b" />{i.name} has negative stock ({i.stock})</li>
            ))}
            <li onClick={() => nav('/chargeback')}><Icon name="chargeback" size={20} color="#457df1" />3 chargebacks open for dispute</li>
            <li onClick={() => nav('/menu/overview')}><Icon name="image" size={20} color="#457df1" />{items.filter((i) => !i.image).length} items have no photo — items with photos sell up to 30% more</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
