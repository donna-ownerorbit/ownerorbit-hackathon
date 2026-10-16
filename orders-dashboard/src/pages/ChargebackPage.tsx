import { useState } from 'react'
import { fmt } from '../data'
import { useStore } from '../store'
import { providerName, type Chargeback } from '../orders'
import { Dialog, ProviderBadge, TextField } from '../ui'
import { PageHeader, Stat } from './HomePage'

export function ChargebackPage() {
  const { chargebacks, toast } = useStore()
  const [overrides, setOverrides] = useState<Record<string, Chargeback['status']>>({})
  const [dispute, setDispute] = useState<Chargeback | null>(null)
  const [note, setNote] = useState('')
  const rows = chargebacks.map((c) => ({ ...c, status: overrides[c.id] ?? c.status }))
  const sum = (s: Chargeback['status'][]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.amount, 0)
  return (
    <div className="page">
      <PageHeader title="Chargeback" sub="Adjustments taken by delivery providers — dispute the ones that weren't your fault" />
      <div className="stat-grid">
        <Stat label="Open" value={fmt(sum(['Open']))} icon="warning" />
        <Stat label="In dispute" value={fmt(sum(['Disputed']))} icon="chat" />
        <Stat label="Recovered" value={fmt(sum(['Won']))} icon="checkCircle" />
        <Stat label="Lost" value={fmt(sum(['Lost']))} icon="chargeback" />
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Order</th><th>Provider</th><th>Date</th><th>Reason</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="strong-cell">{c.orderNumber}</td>
                  <td><div className="row-center gap8"><ProviderBadge id={c.provider} size={22} />{providerName(c.provider)}</div></td>
                  <td>{new Date(c.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}</td>
                  <td>{c.reason}</td>
                  <td style={{ textAlign: 'right', fontWeight: 500 }}>-{fmt(c.amount)}</td>
                  <td><span className={`status-pill cb-${c.status.toLowerCase()}`}>{c.status}</span></td>
                  <td>{c.status === 'Open' && <button className="btn btn-outlined-blue small" onClick={() => setDispute(c)}>Dispute</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Dialog open={!!dispute} onClose={() => setDispute(null)} title={`Dispute ${dispute?.orderNumber}`} actions={<>
        <button className="btn btn-text" onClick={() => setDispute(null)}>Cancel</button>
        <button className="btn btn-primary" disabled={note.trim().length < 10} onClick={() => {
          setOverrides({ ...overrides, [dispute!.id]: 'Disputed' }); toast(`Dispute submitted to ${providerName(dispute!.provider)}`); setDispute(null); setNote('')
        }}>Submit dispute</button>
      </>}>
        <div className="stack">
          <p className="dialog-text">{providerName(dispute?.provider ?? '')} charged back <b>{fmt(dispute?.amount ?? 0)}</b> for “{dispute?.reason}”.</p>
          <TextField label="What happened?" value={note} onChange={setNote} multiline rows={4} placeholder="e.g. Order was picked up complete — photo of sealed bag attached." />
        </div>
      </Dialog>
    </div>
  )
}
