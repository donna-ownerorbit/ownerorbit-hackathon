import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'
import { STATUS_META, type Status } from './data'
import { useStore } from './store'

/* ---------- Outlined text field with floating notched label (MUI style) ---------- */
export function TextField({
  label, value, onChange, multiline, rows = 4, prefix, suffix, disabled, type = 'text', placeholder, style, autoFocus, inputMode,
}: {
  label: string
  value: string
  onChange?: (v: string) => void
  multiline?: boolean
  rows?: number
  prefix?: ReactNode
  suffix?: ReactNode
  disabled?: boolean
  type?: string
  placeholder?: string
  style?: CSSProperties
  autoFocus?: boolean
  inputMode?: 'decimal' | 'numeric' | 'text'
}) {
  const [focus, setFocus] = useState(false)
  return (
    <div className={`tf ${focus ? 'focus' : ''} ${disabled ? 'disabled' : ''}`} style={style}>
      <fieldset aria-hidden>
        <legend><span>{label}</span></legend>
      </fieldset>
      <label className="tf-label">{label}</label>
      <div className="tf-row">
        {prefix && <span className="tf-prefix">{prefix}</span>}
        {multiline ? (
          <textarea rows={rows} value={value} disabled={disabled} placeholder={placeholder} autoFocus={autoFocus}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={(e) => onChange?.(e.target.value)} />
        ) : (
          <input type={type} value={value} disabled={disabled} placeholder={placeholder} autoFocus={autoFocus} inputMode={inputMode}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={(e) => onChange?.(e.target.value)} />
        )}
        {suffix && <span className="tf-suffix">{suffix}</span>}
      </div>
    </div>
  )
}

export function SelectField({ label, value, options, onChange, style }: {
  label: string; value: string; options: string[] | { value: string; label: string }[]; onChange: (v: string) => void; style?: CSSProperties
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  const [focus, setFocus] = useState(false)
  return (
    <div className={`tf select ${focus ? 'focus' : ''}`} style={style}>
      <fieldset aria-hidden><legend><span>{label}</span></legend></fieldset>
      <label className="tf-label">{label}</label>
      <div className="tf-row">
        <select value={value} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={(e) => onChange(e.target.value)}>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Icon name="dropDown" color="#757575" className="select-caret" />
      </div>
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="switch-wrap">
      <span className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} tabIndex={0}
        onClick={(e) => { e.preventDefault(); onChange(!checked) }}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked) } }}>
        <span className="track" /><span className="thumb" />
      </span>
      {label && <span className="switch-label" onClick={() => onChange(!checked)}>{label}</span>}
    </label>
  )
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="checkbox">
      <span className={`box ${checked ? 'on' : ''}`} onClick={(e) => { e.preventDefault(); onChange(!checked) }}>
        {checked && <Icon name="check" size={16} color="#fff" />}
      </span>
      <span onClick={() => onChange(!checked)}>{label}</span>
    </label>
  )
}

export function Radio({ checked, onChange, label, sub }: { checked: boolean; onChange: () => void; label: ReactNode; sub?: ReactNode }) {
  return (
    <label className="radio" onClick={onChange}>
      <span className={`dot ${checked ? 'on' : ''}`} />
      <span><span className="radio-label">{label}</span>{sub && <span className="radio-sub">{sub}</span>}</span>
    </label>
  )
}

/* ---------- Dialog ---------- */
export function Dialog({ open, onClose, title, children, actions, width = 520 }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; actions?: ReactNode; width?: number
}) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="backdrop" onMouseDown={onClose}>
      <div className="dialog" style={{ width }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="dialog-title">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={22} color="#5f6673" /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ---------- Popover menu anchored to an element ---------- */
export function Popover({ anchor, open, onClose, children, align = 'left', width }: {
  anchor: HTMLElement | null; open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const w = ref.current?.offsetWidth ?? width ?? 200
      const h = ref.current?.offsetHeight ?? 0
      let top = r.bottom + 4
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
      let left = align === 'right' ? r.right - w : r.left
      left = Math.min(Math.max(8, left), window.innerWidth - w - 8)
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, anchor, align, width])
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return
      onClose()
    }
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', h)
    window.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k) }
  }, [open, anchor, onClose])
  if (!open) return null
  return createPortal(
    <div ref={ref} className="popover" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}>{children}</div>,
    document.body,
  )
}

export function MenuItem({ children, onClick, icon, danger, selected }: {
  children: ReactNode; onClick: () => void; icon?: ReactNode; danger?: boolean; selected?: boolean
}) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''} ${selected ? 'selected' : ''}`} onClick={onClick}>
      {icon && <span className="menu-icon">{icon}</span>}
      <span>{children}</span>
    </button>
  )
}

/* ---------- Availability dropdown used on item rows ---------- */
export function StatusSelect({ value, onChange, compact }: { value: Status; onChange: (s: Status) => void; compact?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button ref={setAnchor} className={`status-btn ${compact ? 'compact' : ''}`} title={STATUS_META[value].label}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
        <span className="sdot" style={{ background: STATUS_META[value].color }} />
        <Icon name="expandMore" size={18} color="#757575" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="right" width={230}>
        {(Object.keys(STATUS_META) as Status[]).map((s) => (
          <MenuItem key={s} selected={s === value} onClick={() => { onChange(s); setOpen(false) }}
            icon={<span className="sdot" style={{ background: STATUS_META[s].color }} />}>
            {STATUS_META[s].label}
          </MenuItem>
        ))}
      </Popover>
    </>
  )
}

export function Toasts() {
  const { toasts } = useStore()
  return createPortal(
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <Icon name={t.tone === 'error' ? 'warning' : t.tone === 'info' ? 'info' : 'checkCircle'} size={20} />
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  )
}

export function Spinner({ size = 18, color = '#fff' }: { size?: number; color?: string }) {
  return <span className="spinner" style={{ width: size, height: size, borderColor: color, borderTopColor: 'transparent' }} />
}

export function ProviderBadge({ id, size = 26 }: { id: string; size?: number }) {
  const map: Record<string, [string, string]> = {
    website: ['#111', 'W'], doordash: ['#eb1700', 'D'], ubereats: ['#06c167', 'U'], grubhub: ['#ff8000', 'G'],
  }
  const [bg, ch] = map[id] ?? ['#999', '?']
  return (
    <span className="pbadge" style={{ width: size, height: size, background: bg, fontSize: size * 0.46 }}>{ch}</span>
  )
}
