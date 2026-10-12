import { useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Toasts } from './ui'
import { Icon } from './icons'
import MenuPage from './pages/MenuPage'
import { HomePage } from './pages/HomePage'
import { OrdersPage, OrderHistoryPage } from './pages/OrdersPage'
import { ChargebackPage } from './pages/ChargebackPage'
import { ReportsPage } from './pages/ReportsPage'
import { SkillsPage } from './pages/SkillsPage'
import { PublicPage } from './pages/PublicPage'
import { ProvidersPage, WebsitePage, DeliveryPage, SettingsPage, HelpPage, SchedulePage } from './pages/MiscPages'

export default function App() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const loc = useLocation()
  // Customer-facing pages render without the dashboard shell.
  if (loc.pathname.startsWith('/p/')) return <Routes><Route path="/p/:slug" element={<PublicPage />} /></Routes>
  return (
    <div className={`shell ${collapsed ? 'sb-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />
      {mobileOpen && <div className="sb-scrim" onClick={() => setMobileOpen(false)} />}
      <main className="main" key={loc.pathname.split('/')[1]}>
        <button className="mobile-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
          <Icon name="hamburger" />
        </button>
        <Routes>
          <Route path="/" element={<Navigate to="/menu" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/chargeback" element={<ChargebackPage />} />
          <Route path="/order-history" element={<OrderHistoryPage />} />
          <Route path="/menu/*" element={<MenuPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/website" element={<WebsitePage />} />
          <Route path="/delivery" element={<DeliveryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="*" element={<Navigate to="/menu" replace />} />
        </Routes>
      </main>
      <Toasts />
    </div>
  )
}
