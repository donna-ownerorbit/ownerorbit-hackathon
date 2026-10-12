import { useMemo, useState } from 'react'
import { fmt, PROVIDERS } from '../data'
import { useStore } from '../store'
import { Icon } from '../icons'
import { PageHeader, Stat } from './HomePage'

export function ReportsPage() {
  const { orders, items, categories } = useStore()
  const [days, setDays] = useState(14)
  const done = orders.filter((o) => o.status !== 'canceled' && o.placedAt > Date.now() - days * 864e5)

  const daily = useMemo(() => {
    const out: { label: string; total: number; count: number }[] = []
    for (let d = days - 1; d >= 0; d--) {
      const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - d)
      const end = start.getTime() + 864e5
      const os = done.filter((o) => o.placedAt >= start.getTime() && o.placedAt < end)
      out.push({ label: start.toLocaleDateString([], { month: 'numeric', day: 'numeric' }), total: os.reduce((s, o) => s + o.subtotal, 0), count: os.length })
    }
    return out
  }, [done, days])

  const gross = done.reduce((s, o) => s + o.subtotal, 0)
  const max = Math.max(...daily.map((d) => d.total), 1)
  const W = 760, H = 220
  const pts = daily.map((d, i) => [daily.length > 1 ? (i / (daily.length - 1)) * W : W / 2, H - (d.total / max) * (H - 20)])
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')

  const catSales = categories.map((c) => {
    const names = new Set(items.filter((i) => i.categoryId === c.id).map((i) => i.name))
    const total = done.reduce((s, o) => s + o.lines.filter((l) => names.has(l.name)).reduce((a, l) => a + l.qty * l.price, 0), 0)
    return { name: c.name, total }
  }).sort((a, b) => b.total - a.total)
  const catMax = Math.max(...catSales.map((c) => c.total), 1)

  return (
    <div className="page">
      <PageHeader title="Reports" sub="Sales performance across every channel">
        <div className="seg">
          {[7, 14, 30].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}D</button>)}
        </div>
      </PageHeader>
      <div className="stat-grid">
        <Stat label="Gross sales" value={fmt(gross)} delta={6.2} icon="trending" />
        <Stat label="Orders" value={String(done.length)} delta={3.8} icon="orders" />
        <Stat label="Avg. ticket" value={fmt(done.length ? gross / done.length : 0)} delta={2.1} icon="reports" />
        <Stat label="Est. commission" value={fmt(done.filter((o) => o.provider !== 'website').reduce((s, o) => s + o.subtotal * 0.18, 0))} icon="chargeback" />
      </div>
      <div className="card pad">
        <div className="card-head"><h2 className="card-title">Daily sales</h2></div>
        <svg viewBox={`-10 0 ${W + 20} ${H + 30}`} className="line-chart">
          {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={0} x2={W} y1={H - f * (H - 20)} y2={H - f * (H - 20)} stroke="#eee" />)}
          <path d={path + ` L${W} ${H} L0 ${H} Z`} fill="rgba(69,125,241,.10)" />
          <path d={path} fill="none" stroke="#457df1" strokeWidth={2.5} strokeLinejoin="round" />
          {pts.map((p, i) => (
            <g key={i}>
              <circle cx={p[0]} cy={p[1]} r={3.5} fill="#fff" stroke="#457df1" strokeWidth={2}><title>{daily[i].label}: {fmt(daily[i].total)} · {daily[i].count} orders</title></circle>
              {(daily.length <= 14 || i % 3 === 0) && <text x={p[0]} y={H + 22} textAnchor="middle" fontSize="11" fill="#888">{daily[i].label}</text>}
            </g>
          ))}
        </svg>
      </div>
      <div className="home-grid">
        <div className="card pad">
          <div className="card-head"><h2 className="card-title">Sales by category</h2></div>
          <ul className="hbars">
            {catSales.map((c) => (
              <li key={c.name}><span>{c.name}</span><div className="bar"><span style={{ width: `${(c.total / catMax) * 100}%` }} /></div><b>{fmt(c.total)}</b></li>
            ))}
          </ul>
        </div>
        <div className="card pad">
          <div className="card-head"><h2 className="card-title">Channel mix</h2></div>
          <ul className="hbars">
            {PROVIDERS.map((p) => {
              const t = done.filter((o) => o.provider === p.id).reduce((s, o) => s + o.subtotal, 0)
              return <li key={p.id}><span>{p.name}</span><div className="bar"><span style={{ width: `${(t / (gross || 1)) * 100}%`, background: p.color }} /></div><b>{fmt(t)}</b></li>
            })}
          </ul>
          <p className="muted small" style={{ marginTop: 16 }}><Icon name="info" size={16} style={{ verticalAlign: -3 }} /> Website orders carry no marketplace commission.</p>
        </div>
      </div>
    </div>
  )
}
