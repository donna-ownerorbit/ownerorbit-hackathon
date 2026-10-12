import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../store'
import { STORES } from '../data'

interface SitePage {
  slug: string; version: number; title: string; headline: string; intro?: string
  sections?: { heading: string; body: string }[]; highlights?: string[]
  cta?: { label: string; href: string }; contact?: string; published: boolean; updatedAt: string
}

const PRICE_LINE = /^(.+?)\s*[—–:-]?\s*\$(\d+(?:\.\d{2})?)\s*(.*)$/

/** A paragraph of "Item $12.99" lines renders as a menu price list; anything else keeps its line breaks. */
function Block({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const priced = lines.map((l) => l.match(PRICE_LINE))
  if (lines.length > 1 && priced.filter(Boolean).length >= Math.ceil(lines.length * 0.7)) {
    return (
      <ul className="pp-menu">
        {lines.map((l, i) => {
          const m = priced[i]
          if (!m) return <li key={i} className="pp-menu-note">{l}</li>
          return <li key={i}><span className="pp-menu-name">{m[1].replace(/[\s—–:-]+$/, '')}{m[3] && <small>{m[3]}</small>}</span><span className="pp-menu-dots" /><b>${m[2]}</b></li>
        })}
      </ul>
    )
  }
  return <p className="pp-para">{text}</p>
}

/** Customer-facing page published from the dashboard or by Donna (e.g. /p/catering). No dashboard chrome. */
export function PublicPage() {
  const { slug = '' } = useParams()
  const [page, setPage] = useState<SitePage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api<{ page: SitePage }>('GET', `pages/${slug}`)
      .then((r) => { if (live) { setPage(r.page); document.title = `${r.page.title} · Falafel Flare` } })
      .catch((e) => live && setError((e as Error).message))
    return () => { live = false }
  }, [slug])

  if (error || (page && !page.published)) {
    return <div className="pp pp-missing" data-page-slug={slug} data-state="missing"><h1>Page not found</h1><p>{error ?? 'This page is not published.'}</p></div>
  }
  if (!page) return <div className="pp pp-loading" data-state="loading" />

  return (
    <div className="pp" data-page-slug={page.slug} data-version={page.version} data-state="ready">
      <header className="pp-hero">
        <div className="pp-brand">Falafel Flare</div>
        <h1 className="pp-title">{page.title}</h1>
        <p className="pp-headline">{page.headline}</p>
        {page.cta && <a className="pp-cta" href={page.cta.href}>{page.cta.label}</a>}
      </header>
      <main className="pp-body">
        {page.intro && <p className="pp-intro">{page.intro}</p>}
        {!!page.highlights?.length && (
          <ul className="pp-highlights">{page.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
        )}
        {page.sections?.map((s, i) => (
          <section key={i} className="pp-section">
            <h2>{s.heading}</h2>
            {s.body.split(/\n{2,}/).map((para, j) => <Block key={j} text={para} />)}
          </section>
        ))}
        {page.cta && <a className="pp-cta pp-cta-bottom" href={page.cta.href}>{page.cta.label}</a>}
      </main>
      <footer className="pp-foot">
        {page.contact && <div>{page.contact}</div>}
        <div>{STORES.map((s) => s.address).join(' · ')}</div>
      </footer>
    </div>
  )
}
