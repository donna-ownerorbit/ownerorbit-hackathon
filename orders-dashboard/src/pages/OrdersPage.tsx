import { Fragment, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../icons'
import { fmt, PROVIDERS } from '../data'
import { useStore } from '../store'
import { providerName, timeAgo, type Order, type OrderStatus } from '../orders'
import { ProviderBadge, SelectField } from '../ui'
import { PageHeader } from './HomePage'

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  new: { to: 'preparing', label: 'Accept & prepare' },
  preparing: { to: 'ready', label: 'Mark ready' },
  ready: { to: 'completed', label: 'Complete' },
}

export function OrdersPage() {
  const { orders, setOrderStatus, toast } = useStore()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'active' | 'completed'>('active')
  const list = orders.filter((o) => (tab === 'active' ? ['new', 'preparing', 'ready'].includes(o.status) : o.status === 'completed' && o.placedAt > Date.now() - 864e5))
  const selected = orders.find((o) => o.id === params.get('o')) ?? list[0]

  return (
    <div className="page">
      <PageHeader title="Orders" sub="Live orders from every provider in one queue">
        <div className="seg">
          <button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}>Active ({orders.filter((o) => ['new', 'preparing', 'ready'].includes(o.status)).length})</button>
          <button className={tab === 'completed' ? 'on' : ''} onClick={() => setTab('completed')}>Completed today</button>
        </div>
      </PageHeader>
      <div className="orders-layout">
        <div className="card order-list">
          {list.length === 0 && <div className="no-results">No orders here right now.</div>}
          {list.map((o) => (
            <button key={o.id} className={`order-row ${selected?.id === o.id ? 'selected' : ''}`} onClick={() => setParams({ o: o.id }, { replace: true })}>
              <ProviderBadge id={o.provider} size={34} />
              <div className="order-row-main">
                <div className="row-center gap8"><b>{o.number}</b><span className={`status-pill s-${o.status}`}>{o.status}</span></div>
                <div className="muted small">{o.customer} · {o.type} · {o.lines.reduce((s, l) => s + l.qty, 0)} items</div>
              </div>
              <div className="order-row-right"><b>{fmt(o.total)}</b><span className="muted small">{timeAgo(o.placedAt)}</span></div>
            </button>
          ))}
        </div>
        {selected && <OrderTicket order={selected} onAdvance={(to) => { setOrderStatus(selected.id, to); toast(`${selected.number} → ${to}`) }} />}
      </div>
    </div>
  )
}

function OrderTicket({ order: o, onAdvance }: { order: Order; onAdvance: (s: OrderStatus) => void }) {
  const { toast } = useStore()
  const next = NEXT[o.status]
  return (
    <div className="card ticket">
      <div className="ticket-head">
        <ProviderBadge id={o.provider} size={40} />
        <div>
          <h2>{o.number}</h2>
          <div className="muted">{providerName(o.provider)} · {o.type} · placed {new Date(o.placedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
        </div>
        <span style={{ flex: 1 }} />
        <span className={`status-pill lg s-${o.status}`}>{o.status}</span>
      </div>
      <div className="ticket-customer">
        <div><Icon name="person" size={20} color="#5f6673" /> {o.customer}</div>
        <div><Icon name="phone" size={20} color="#5f6673" /> {o.phone}</div>
        {o.courier && <div><Icon name="truck" size={20} color="#5f6673" /> Courier: {o.courier}</div>}
      </div>
      <ul className="ticket-lines">
        {o.lines.map((l, i) => (
          <li key={i}>
            <span className="qty">{l.qty}×</span>
            <div><b>{l.name}</b>{l.note && <div className="ticket-note">“{l.note}”</div>}</div>
            <span>{fmt(l.qty * l.price)}</span>
          </li>
        ))}
      </ul>
      <dl className="ticket-totals">
        <dt>Subtotal</dt><dd>{fmt(o.subtotal)}</dd>
        <dt>Tax</dt><dd>{fmt(o.tax)}</dd>
        {o.tip > 0 && <><dt>Tip</dt><dd>{fmt(o.tip)}</dd></>}
        <dt className="total">Total</dt><dd className="total">{fmt(o.total)}</dd>
      </dl>
      <div className="ticket-actions">
        <button className="btn btn-outlined-blue" onClick={() => toast('Ticket sent to kitchen printer', 'info')}><Icon name="print" size={20} />Print</button>
        {o.status === 'new' && <button className="btn btn-text danger" onClick={() => onAdvance('canceled')}>Reject</button>}
        <span style={{ flex: 1 }} />
        {next && <button className="btn btn-primary" onClick={() => onAdvance(next.to)}>{next.label}</button>}
      </div>
    </div>
  )
}

export function OrderHistoryPage() {
  const { orders } = useStore()
  const [q, setQ] = useState('')
  const [prov, setProv] = useState('all')
  const [range, setRange] = useState('30')
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const PER = 15
  const rows = useMemo(() => orders.filter((o) =>
    o.placedAt > Date.now() - +range * 864e5 && (prov === 'all' || o.provider === prov) &&
    (!q || (o.number + o.customer).toLowerCase().includes(q.toLowerCase()))), [orders, q, prov, range])
  const total = rows.filter((r) => r.status !== 'canceled').reduce((s, r) => s + r.total, 0)
  const pages = Math.max(1, Math.ceil(rows.length / PER))

  const exportCsv = () => {
    const csv = ['Order,Date,Provider,Customer,Type,Status,Total', ...rows.map((o) =>
      [o.number, new Date(o.placedAt).toISOString(), providerName(o.provider), o.customer, o.type, o.status, o.total].join(','))].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'order-history.csv'
    a.click()
  }

  return (
    <div className="page">
      <PageHeader title="Order history" sub={`${rows.length} orders · ${fmt(total)} gross`}>
        <button className="btn btn-outlined-blue" onClick={exportCsv}><Icon name="download" size={20} />Export CSV</button>
      </PageHeader>
      <div className="card table-card">
        <div className="table-toolbar">
          <div className="search small">
            <Icon name="search" size={20} color="#333" />
            <input placeholder="Order # or customer" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} />
          </div>
          <div className="toolbar-right">
            <SelectField label="Provider" value={prov} onChange={(v) => { setProv(v); setPage(0) }} style={{ width: 200 }}
              options={[{ value: 'all', label: 'All providers' }, ...PROVIDERS.map((p) => ({ value: p.id, label: p.name }))]} />
            <SelectField label="Date range" value={range} onChange={(v) => { setRange(v); setPage(0) }} style={{ width: 160 }}
              options={[{ value: '1', label: 'Today' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '365', label: 'All time' }]} />
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table hover">
            <thead><tr><th>Order</th><th>Date</th><th>Provider</th><th>Customer</th><th>Type</th><th>Status</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
            <tbody>
              {rows.slice(page * PER, page * PER + PER).map((o) => (
                <Fragment key={o.id}>
                  <tr onClick={() => setOpen(open === o.id ? null : o.id)}>
                    <td className="strong-cell">{o.number}</td>
                    <td>{new Date(o.placedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td><div className="row-center gap8"><ProviderBadge id={o.provider} size={22} />{providerName(o.provider)}</div></td>
                    <td>{o.customer}</td>
                    <td>{o.type}</td>
                    <td><span className={`status-pill s-${o.status}`}>{o.status}</span></td>
                    <td style={{ textAlign: 'right', fontWeight: 500 }}>{fmt(o.total)}</td>
                  </tr>
                  {open === o.id && (
                    <tr className="expand-row"><td colSpan={7}>
                      {o.lines.map((l, i) => <span key={i} className="line-chip">{l.qty}× {l.name}</span>)}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted small">Page {page + 1} of {pages}</span>
          <button className="icon-btn" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous"><Icon name="chevronLeft" /></button>
          <button className="icon-btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next"><Icon name="chevronRight" /></button>
        </div>
      </div>
    </div>
  )
}
