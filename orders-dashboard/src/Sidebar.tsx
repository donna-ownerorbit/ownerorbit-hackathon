import { NavLink } from 'react-router-dom'
import { BRAND } from './brand'
import { Icon, type IconName } from './icons'
import { useCurrentStore, useStore } from './store'

export const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/home', label: 'Home', icon: 'home' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  { to: '/chargeback', label: 'Chargeback', icon: 'chargeback' },
  { to: '/order-history', label: 'Order history', icon: 'history' },
  { to: '/menu', label: 'Menu', icon: 'menu' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
  { to: '/providers', label: 'Providers', icon: 'settings' },
  { to: '/website', label: 'Website', icon: 'globe' },
  { to: '/delivery', label: 'Delivery Service', icon: 'truck' },
  { to: '/skills', label: 'Agent skills', icon: 'star' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/help', label: 'Help', icon: 'help' },
  { to: '/schedule', label: 'Schedule', icon: 'schedule' },
]

export function Sidebar({ collapsed, onToggle, mobileOpen, onNavigate }: {
  collapsed: boolean; onToggle: () => void; mobileOpen: boolean; onNavigate: () => void
}) {
  const store = useCurrentStore()
  const { orders, toast, mode, dbName } = useStore()
  const newCount = orders.filter((o) => o.status === 'new').length
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="sb-head">
        <button className="sb-back" onClick={onToggle} aria-label="Toggle sidebar">
          <Icon name="chevronLeft" size={26} color="#fff" style={{ transform: collapsed ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
        </button>
        <img src={BRAND.logo} className="sb-logo" alt="" />
        <span className="sb-brand">{BRAND.name}</span>
      </div>
      <div className="sb-store" title={`${store.name} - ${store.address}`}>{store.name} - Falafel Flare</div>
      <nav className="sb-nav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} onClick={onNavigate} className={({ isActive }) => `sb-item ${isActive ? 'active' : ''}`} title={n.label}>
            <Icon name={n.icon} size={26} color="#fff" />
            <span className="sb-label">{n.label}</span>
            {n.to === '/orders' && newCount > 0 && <span className="sb-badge">{newCount}</span>}
          </NavLink>
        ))}
      </nav>
      <div className={`sb-sync ${mode}`} title={mode === 'db' ? `Live data from MongoDB (${dbName})` : mode === 'local' ? 'Database unreachable — changes are saved in this browser only' : 'Connecting…'}>
        <span className="sb-sync-dot" />
        <span className="sb-label">{mode === 'db' ? `Synced · ${dbName}` : mode === 'local' ? 'Offline · local only' : 'Connecting…'}</span>
      </div>
      <div className="sb-foot">
        <button className="sb-item" onClick={() => toast('Auth is disabled in this build — you stay signed in.', 'info')} title="Log out">
          <Icon name="logout" size={26} color="#fff" />
          <span className="sb-label">Log out</span>
        </button>
      </div>
    </aside>
  )
}
