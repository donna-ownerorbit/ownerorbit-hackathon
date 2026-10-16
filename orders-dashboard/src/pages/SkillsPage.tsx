import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../icons'
import { api, useStore } from '../store'
import { Dialog, Switch, TextField } from '../ui'
import { PageHeader } from './HomePage'

interface Skill {
  skillId: string; version: number; name: string; description: string; instructions: string
  enabled: boolean; author: 'seed' | 'dashboard' | 'agent'; note: string; createdAt: string; pendingProposals?: number
}
interface Proposal {
  id: string; skillId: string; baseVersion: number; reason: string; createdAt: string
  proposal: Partial<Pick<Skill, 'name' | 'description' | 'instructions'>>
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
const AUTHOR = { seed: 'Default', dashboard: 'You', agent: 'Agent (approved)' }

/** Line diff via LCS: fine for playbook-sized text. */
function diffLines(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n')
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: { op: ' ' | '-' | '+'; text: string }[] = []
  let i = 0, j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: x[i++] })
    else out.push({ op: '+', text: y[j++] })
  }
  while (i < x.length) out.push({ op: '-', text: x[i++] })
  while (j < y.length) out.push({ op: '+', text: y[j++] })
  return out
}

function Diff({ from, to }: { from: string; to: string }) {
  return (
    <pre className="skill-diff">
      {diffLines(from, to).map((l, k) => <div key={k} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}>{l.op} {l.text || ' '}</div>)}
    </pre>
  )
}

export function SkillsPage() {
  const { toast, mode } = useStore()
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api<{ skills: Skill[] }>('GET', 'skills')
      setSkills(r.skills); setError(null)
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  const toggle = async (s: Skill, enabled: boolean) => {
    setSkills((list) => list?.map((x) => (x.skillId === s.skillId ? { ...x, enabled } : x)) ?? null)
    try {
      await api('PUT', `skills/${s.skillId}`, { enabled, baseVersion: s.version })
      toast(`${s.name} ${enabled ? 'enabled' : 'disabled'}`, 'info')
    } catch (e) { toast((e as Error).message, 'error') }
    load()
  }

  const pending = skills?.reduce((n, s) => n + (s.pendingProposals ?? 0), 0) ?? 0
  const open = skills?.find((s) => s.skillId === openId) ?? null

  return (
    <div className="page">
      <PageHeader title="Agent skills" sub="Playbooks your ordering agent follows. Every change is saved as a new version; the agent can only suggest edits for you to approve.">
        <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!skills}><Icon name="add" color="#fff" /> New skill</button>
      </PageHeader>

      {error && (
        <div className="card pad empty-state">
          <Icon name="warning" size={40} color="#e5483b" />
          <p><b>Skills couldn't load.</b> {mode === 'local' ? 'The database is unreachable, and skills are only stored there.' : error}</p>
          <button className="btn btn-outlined-blue" onClick={load}>Try again</button>
        </div>
      )}
      {!skills && !error && <div className="muted pad">Loading…</div>}
      {skills && pending > 0 && <div className="skill-banner"><Icon name="info" size={20} color="#2955b8" /> The agent suggested {pending} change{pending > 1 ? 's' : ''}. Open the highlighted skill{pending > 1 ? 's' : ''} to review.</div>}

      {skills && (
        <div className="skill-grid">
          {skills.map((s) => (
            <div key={s.skillId} className={`card skill-card ${s.enabled ? '' : 'off'} ${s.pendingProposals ? 'has-proposal' : ''}`}>
              <div className="row-center gap12">
                <button className="skill-name" onClick={() => setOpenId(s.skillId)}>{s.name}</button>
                <span style={{ flex: 1 }} />
                <Switch checked={s.enabled} onChange={(v) => toggle(s, v)} />
              </div>
              <p className="muted small skill-desc">{s.description || 'No description.'}</p>
              <div className="row-center gap12 small">
                <span className="pill">v{s.version}</span>
                <span className="muted">{AUTHOR[s.author]} · {ago(s.createdAt)}</span>
                <span style={{ flex: 1 }} />
                {!!s.pendingProposals && <span className="pill pill-blue">{s.pendingProposals} to review</span>}
                <button className="btn btn-text small" onClick={() => setOpenId(s.skillId)}>Open</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && <SkillEditor key={open.skillId + open.version} skill={open} onClose={() => setOpenId(null)} onChanged={load} />}
      <NewSkillDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load().then(() => setOpenId(id)) }} />
    </div>
  )
}

function SkillEditor({ skill, onClose, onChanged }: { skill: Skill; onClose: () => void; onChanged: () => Promise<void> }) {
  const { toast } = useStore()
  const [tab, setTab] = useState<'edit' | 'history' | 'review'>(skill.pendingProposals ? 'review' : 'edit')
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [instructions, setInstructions] = useState(skill.instructions)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<{ versions: Skill[]; proposals: Proposal[] } | null>(null)
  const [peek, setPeek] = useState<number | null>(null)

  useEffect(() => { api<{ versions: Skill[]; proposals: Proposal[] }>('GET', `skills/${skill.skillId}`).then(setDetail).catch((e) => toast(e.message, 'error')) }, [skill.skillId, skill.version, toast])

  const dirty = name !== skill.name || description !== skill.description || instructions !== skill.instructions
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast(ok); await onChanged() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  const save = () => run(() => api('PUT', `skills/${skill.skillId}`, { name, description, instructions, note, baseVersion: skill.version }), `Saved ${name} as v${skill.version + 1}`)
  const revert = (v: number) => run(() => api('POST', `skills/${skill.skillId}/revert`, { version: v }), `Restored v${v} as v${skill.version + 1}`)
  const decide = (p: Proposal, action: 'approve' | 'reject') => run(() => api('POST', `approvals/${p.id}/${action}`, {}), action === 'approve' ? 'Change approved' : 'Suggestion dismissed')
  const peeked = useMemo(() => detail?.versions.find((v) => v.version === peek), [detail, peek])

  return (
    <Dialog open onClose={onClose} width={760} title={<span>{skill.name} <span className="pill">v{skill.version}</span></span>}
      actions={tab === 'edit' ? (
        <>
          <button className="btn btn-text" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={!dirty || busy || !instructions.trim()} onClick={save}>Save as v{skill.version + 1}</button>
        </>
      ) : <button className="btn btn-text" onClick={onClose}>Close</button>}>
      <div className="skill-tabs" role="tablist">
        {(['edit', 'history', 'review'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'edit' ? 'Edit' : t === 'history' ? `History${detail ? ` (${detail.versions.length})` : ''}` : `Suggestions${detail?.proposals.length ? ` (${detail.proposals.length})` : ''}`}
          </button>
        ))}
      </div>

      {tab === 'edit' && (
        <div className="stack">
          <TextField label="Name" value={name} onChange={setName} />
          <TextField label="When to use it" value={description} onChange={setDescription} />
          <TextField label="Instructions" value={instructions} onChange={setInstructions} multiline rows={14} />
          {dirty && <TextField label="What changed? (optional)" value={note} onChange={setNote} />}
          {dirty && instructions !== skill.instructions && <Diff from={skill.instructions} to={instructions} />}
        </div>
      )}

      {tab === 'history' && (
        <div className="stack">
          {!detail && <div className="muted">Loading…</div>}
          {detail?.versions.map((v) => (
            <div key={v.version} className="skill-version">
              <div className="row-center gap12">
                <span className="pill">v{v.version}</span>
                <span className="small"><b>{v.note || 'Edited'}</b> <span className="muted">· {AUTHOR[v.author]} · {ago(v.createdAt)}{v.enabled ? '' : ' · disabled'}</span></span>
                <span style={{ flex: 1 }} />
                <button className="btn btn-text small" onClick={() => setPeek(peek === v.version ? null : v.version)}>{peek === v.version ? 'Hide' : 'Compare'}</button>
                {v.version !== skill.version && <button className="btn btn-outlined-blue small" disabled={busy} onClick={() => revert(v.version)}>Restore</button>}
              </div>
              {peeked && peek === v.version && <Diff from={peeked.instructions} to={skill.instructions} />}
            </div>
          ))}
          {peek !== null && <div className="muted small">Comparing the selected version (−) with the current one (+).</div>}
        </div>
      )}

      {tab === 'review' && (
        <div className="stack">
          {detail && !detail.proposals.length && <div className="muted">Nothing to review. When the agent thinks this playbook should change, its suggestion shows up here.</div>}
          {detail?.proposals.map((p) => (
            <div key={p.id} className="skill-version">
              <div className="small"><b>Agent suggestion</b> <span className="muted">· {ago(p.createdAt)} · written against v{p.baseVersion}</span></div>
              {p.baseVersion !== skill.version && <div className="small skill-stale"><Icon name="warning" size={16} color="#b7791f" /> The skill changed after this was suggested. The diff below is against the current v{skill.version}.</div>}
              <p className="small">“{p.reason}”</p>
              {p.proposal.name && <div className="small">Name: <s>{skill.name}</s> → <b>{p.proposal.name}</b></div>}
              {p.proposal.description !== undefined && <div className="small">Description: <b>{p.proposal.description}</b></div>}
              {p.proposal.instructions !== undefined && <Diff from={skill.instructions} to={p.proposal.instructions} />}
              <div className="row-center gap12" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-text" disabled={busy} onClick={() => decide(p, 'reject')}>Dismiss</button>
                <button className="btn btn-primary" disabled={busy} onClick={() => decide(p, 'approve')}>Approve as v{skill.version + 1}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}

function NewSkillDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const skillId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const create = async () => {
    setBusy(true)
    try {
      await api('POST', 'skills', { skillId, name: name.trim(), description, instructions })
      toast(`Created ${name.trim()}`)
      setName(''); setDescription(''); setInstructions('')
      onCreated(skillId)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={onClose} title="New skill" width={640}
      actions={<><button className="btn btn-text" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !skillId || !instructions.trim()} onClick={create}>Create</button></>}>
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} placeholder="Catering requests" autoFocus />
        <TextField label="When to use it" value={description} onChange={setDescription} placeholder="Handling large or advance orders" />
        <TextField label="Instructions" value={instructions} onChange={setInstructions} multiline rows={10} placeholder={'- Step-by-step rules the agent should follow\n- Which tools to use, and when to ask you first'} />
      </div>
    </Dialog>
  )
}
