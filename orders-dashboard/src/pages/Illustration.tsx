// Original line-art scene: a menu board, a chef's cloche, plant and shelf.
export function EmptyIllustration() {
  const s = { fill: 'none', stroke: '#111', strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg viewBox="0 0 600 440" className="empty-illu" aria-hidden>
      <ellipse cx="330" cy="230" rx="190" ry="185" fill="#f5f5f5" />
      {/* menu board */}
      <rect x="250" y="60" width="200" height="250" rx="6" {...s} fill="#fff" />
      <line x1="250" y1="92" x2="450" y2="92" {...s} />
      <path d="M425 70l12 12M437 70l-12 12" {...s} />
      <circle cx="272" cy="76" r="5" fill="#111" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i} transform={`translate(0 ${i * 50})`}>
          <rect x="272" y="112" width="34" height="34" rx="17" {...s} />
          <line x1="320" y1="120" x2="420" y2="120" {...s} />
          <line x1="320" y1="138" x2="390" y2="138" {...s} strokeWidth={2} stroke="#888" />
          <circle cx="430" cy="138" r="4" fill={i === 1 ? '#f0b130' : '#111'} />
        </g>
      ))}
      {/* waves */}
      <path d="M462 140c12-12 24 12 36 0s24 12 36 0" {...s} />
      <path d="M462 165c12-12 24 12 36 0s24 12 36 0" {...s} />
      {/* cloche */}
      <path d="M110 300a70 70 0 01140 0z" {...s} fill="#fff" />
      <circle cx="180" cy="222" r="9" {...s} fill="#fff" />
      <line x1="90" y1="300" x2="270" y2="300" {...s} strokeWidth={5} />
      <path d="M150 262c8-12 22-18 34-18" {...s} />
      {/* sparkle */}
      <path d="M175 165v-22M150 175l-14-14M200 175l14-14" {...s} />
      {/* black bar */}
      <rect x="300" y="330" width="230" height="40" fill="#111" />
      {/* plant + shelf */}
      <rect x="60" y="330" width="100" height="70" {...s} fill="#fff" />
      <line x1="60" y1="365" x2="160" y2="365" {...s} />
      <circle cx="110" cy="348" r="5" fill="#111" />
      <circle cx="110" cy="383" r="5" fill="#111" />
      <path d="M88 330l-6-30h40l-6 30" {...s} fill="#fff" />
      <path d="M102 300v-34M102 284c-10-8-18-6-20 2M102 276c10-10 20-8 22 0" {...s} />
      <circle cx="102" cy="260" r="7" {...s} fill="#fff" />
      <rect x="132" y="290" width="16" height="40" rx="3" {...s} fill="#fff" />
      {/* pizza slice + circle */}
      <path d="M560 400l-40-90" {...s} />
      <rect x="380" y="380" width="70" height="20" fill="#111" />
      <path d="M470 300l30 60h-60z" fill="#111" />
      <circle cx="555" cy="335" r="16" fill="#111" />
      <line x1="30" y1="408" x2="580" y2="408" {...s} />
    </svg>
  )
}
