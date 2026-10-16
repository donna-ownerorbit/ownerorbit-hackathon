import { execFileSync } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.ts'
import { C, getDb, normalizeHandle, rid } from '../db/mongo.ts'
import { enqueue } from '../inbox/worker.ts'

/**
 * GitHub → MongoDB → OwnerOrbit.
 *
 * Saddiq's side commits instructions/briefs to a GitHub repo. This module pulls the latest commits
 * on the watched branch into MongoDB (`github_commits`: sha, author, message, changed files with
 * patch + full text at that commit), then hands each new commit to the same inbox the iMessage
 * adapter uses. The worker runs it through identity → RBAC → Haiku agent + skills → live dashboard
 * → verification, and writes the analysis/results back onto the commit document.
 *
 * Identity is deterministic: the commit author's GitHub login (or email) must map to a principal
 * (`principals.github` in MongoDB, or GITHUB_PRINCIPALS env). Unmapped authors are stored but never
 * executed. Pulling is idempotent: (repo, sha) is unique and the inbox dedupes on `github:<sha>`.
 */

export interface CommitFile { path: string; status: string; additions: number; deletions: number; patch: string | null; text: string | null }
export interface CommitDoc {
  restaurantId: string; repo: string; branch: string; sha: string; url: string
  author: { login: string | null; name: string; email: string }; message: string; committedAt: Date
  files: CommitFile[]; text: string
  /** message = a chat message file (handled like an iMessage); brief = a document for the agent to analyse. */
  mode: 'message' | 'brief'
  replyCommit?: { path: string; sha: string; url: string }
  status: 'pulled' | 'queued' | 'processing' | 'done' | 'failed' | 'skipped'
  skipReason?: string; principal?: string; touchesWatched?: string[]; messageId?: string; pulledAt: Date
  reply?: string; results?: unknown[]; planner?: string; processedAt?: Date
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export const REPLY_PREFIX = '[ownerorbit]'
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv)$/i
const MAX_FILE_CHARS = 12_000
const MAX_TEXT_CHARS = 20_000

let cachedToken: string | null = null
function token() {
  if (config.github.token) return config.github.token
  if (cachedToken !== null) return cachedToken
  try { cachedToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { cachedToken = '' }
  return cachedToken
}

export const githubConfigured = () => /^[\w.-]+\/[\w.-]+$/.test(config.github.repo)

export class GitHubSync {
  constructor(private f: Fetch = fetch, private enqueueFn: typeof enqueue = enqueue) {}

  private async gh<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const t = token()
    const res = await this.f(`https://api.github.com${path}`, {
      method: init.method ?? 'GET', ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ownerorbit', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 160)}`)
    }
    return res.json() as Promise<T>
  }

  private watched(path: string) {
    const under = (p: string, dir: string) => !!dir && (p === dir || p.startsWith(dir + '/'))
    if (under(path, config.github.repliesDir)) return false // never read our own replies back
    if (under(path, config.github.messagesDir)) return true
    const prefixes = config.github.paths
    if (!prefixes.length) return !config.github.messagesDir // with a messages dir, nothing else counts unless GITHUB_PATHS says so
    return prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'))
  }

  /** Full text of one file at the commit (so Haiku sees the whole brief, not only the diff). */
  private async fileText(sha: string, path: string): Promise<string | null> {
    if (!TEXT_EXT.test(path)) return null
    const r = await this.gh<{ content?: string; encoding?: string; size?: number }>(`/repos/${config.github.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`)
    if (!r.content || r.encoding !== 'base64') return null
    const s = Buffer.from(r.content, 'base64').toString('utf8')
    return s.length > MAX_FILE_CHARS ? s.slice(0, MAX_FILE_CHARS) + '\n…(truncated)' : s
  }

  /** Who may this commit act as? Login first, then commit email. Never decided by a model. */
  async principalFor(author: CommitDoc['author']): Promise<{ phone: string; name: string } | null> {
    const keys = [author.login, author.email].filter(Boolean).map((k) => k!.toLowerCase())
    for (const [k, phone] of Object.entries(config.github.principals)) if (keys.includes(k.toLowerCase())) return { phone, name: author.name }
    const db = await getDb()
    const row = await db.collection(C.principals).findOne({ restaurantId: rid(), active: { $ne: false }, github: { $in: keys } })
    return row ? { phone: row.phone as string, name: row.name as string } : null
  }

  async fetchCommit(sha: string): Promise<Omit<CommitDoc, 'status' | 'pulledAt' | 'mode'> & { mode: CommitDoc['mode']; allPaths: string[] }> {
    type Full = {
      sha: string; html_url: string; author: { login: string } | null
      commit: { message: string; author: { name: string; email: string; date: string } }
      files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[]
    }
    const c = await this.gh<Full>(`/repos/${config.github.repo}/commits/${sha}`)
    const files: CommitFile[] = []
    for (const f of (c.files ?? []).filter((x) => this.watched(x.filename)).slice(0, 20)) {
      const text = f.status === 'removed' ? null : await this.fileText(c.sha, f.filename).catch(() => null)
      files.push({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ? f.patch.slice(0, MAX_FILE_CHARS) : null, text })
    }
    const author = { login: c.author?.login ?? null, name: c.commit.author.name, email: c.commit.author.email }
    const doc = {
      restaurantId: rid(), repo: config.github.repo, branch: config.github.branch, sha: c.sha, url: c.html_url,
      author, message: c.commit.message, committedAt: new Date(c.commit.author.date), files, text: '', mode: 'brief' as CommitDoc['mode'],
      allPaths: (c.files ?? []).map((f) => f.filename),
    }
    const dir = config.github.messagesDir
    const msgs = dir ? files.filter((f) => f.path.startsWith(dir + '/') && f.status !== 'removed' && f.text?.trim()) : []
    if (msgs.length) { doc.mode = 'message'; doc.text = msgs.map((f) => f.text!.trim()).join('\n') }
    else doc.text = composeText(doc)
    return doc
  }

  /**
   * Pull new commits into MongoDB and queue them for the agent. Returns what happened per commit.
   * First run with an empty collection only backfills `GITHUB_BACKFILL` commits (default 1: the latest).
   */
  async pull(opts: { execute?: boolean; limit?: number } = {}) {
    if (!githubConfigured()) throw new Error('GITHUB_REPO is not set (owner/name)')
    const db = await getDb()
    const coll = db.collection<CommitDoc>(C.githubCommits)
    const repo = config.github.repo
    const list = await this.gh<{ sha: string }[]>(`/repos/${repo}/commits?sha=${encodeURIComponent(config.github.branch)}&per_page=${opts.limit ?? 20}`)
    const known = new Set((await coll.find({ restaurantId: rid(), repo, sha: { $in: list.map((c) => c.sha) } }, { projection: { sha: 1 } }).toArray()).map((d) => d.sha))
    const first = !(await coll.countDocuments({ restaurantId: rid(), repo }, { limit: 1 }))
    const fresh = list.filter((c) => !known.has(c.sha)).slice(0, first ? config.github.backfill : undefined).reverse() // oldest first

    const out: { sha: string; status: CommitDoc['status']; reason?: string; messageId?: string }[] = []
    for (const { sha } of fresh) {
      const c = await this.fetchCommit(sha)
      let status: CommitDoc['status'] = 'pulled'
      let skipReason: string | undefined
      let principal: string | undefined
      const who = await this.principalFor(c.author)
      if (c.message.startsWith(REPLY_PREFIX)) { status = 'skipped'; skipReason = 'our own reply commit' }
      else if (!c.files.length && (config.github.paths.length || config.github.messagesDir)) { status = 'skipped'; skipReason = `no changes under ${[config.github.messagesDir, ...config.github.paths].filter(Boolean).join(', ')}` }
      else if (!who) { status = 'skipped'; skipReason = `author ${c.author.login ?? c.author.email} is not mapped to a principal` }
      else principal = normalizeHandle(who.phone)
      const touchesWatched = c.allPaths.filter((f) => config.github.watchFiles.includes(f))
      if (touchesWatched.length) console.warn(`⚠️  ${repo}@${c.sha.slice(0, 7)} changed ${touchesWatched.join(', ')} — check the harness bridge still matches (${c.message.split('\n')[0]})`)
      const { allPaths, ...commit } = c
      void allPaths
      try {
        await coll.insertOne({ ...commit, status, skipReason, principal, touchesWatched, pulledAt: new Date() })
      } catch (e) {
        if ((e as { code?: number }).code === 11000) continue // another worker pulled it first
        throw e
      }
      let messageId: string | undefined
      if (status === 'pulled' && who && opts.execute !== false) {
        messageId = `github:${c.sha}`
        await this.enqueueFn({ from: who.phone, text: c.text, messageId, channel: c.mode === 'message' ? 'github-message' : 'github', chat: imessageChat(who.phone) })
        status = 'queued'
        await coll.updateOne({ restaurantId: rid(), repo, sha: c.sha }, { $set: { status, messageId } })
      }
      out.push({ sha: c.sha.slice(0, 7), status, reason: skipReason, messageId })
    }
    return { repo, branch: config.github.branch, checked: list.length, pulled: out }
  }

  /** Agent → GitHub: commit the reply to replies/<sha>.md so whoever wrote the message can read it back. */
  async pushReply(messageId: string, r: { text: string; reply: string; results: { skill: string; outcome: string; verified: boolean | null }[]; planner: string }) {
    const sha = messageId.match(/^github:([0-9a-f]{7,40})/i)?.[1]
    if (!sha || !config.github.repliesDir || !githubConfigured()) return null
    const path = `${config.github.repliesDir}/${sha.slice(0, 12)}${messageId.includes(':replay:') ? '-replay-' + Date.now() : ''}.md`
    const body = [
      `# OwnerOrbit reply to ${sha.slice(0, 7)}`, '', '**Message**', '', '> ' + r.text.split('\n').slice(0, 40).join('\n> '), '',
      `**Reply** (${r.planner}, ${new Date().toISOString()})`, '', r.reply, '',
      ...(r.results.length ? ['**Actions**', '', ...r.results.map((x) => `- ${x.skill}: ${x.outcome}${x.verified === null ? '' : x.verified ? ' (verified)' : ' (NOT verified)'}`)] : []),
    ].join('\n')
    const res = await this.gh<{ content: { path: string }; commit: { sha: string; html_url: string } }>(`/repos/${config.github.repo}/contents/${path}`, {
      method: 'PUT', body: { message: `${REPLY_PREFIX} reply to ${sha.slice(0, 7)}`, content: Buffer.from(body).toString('base64'), branch: config.github.branch },
    })
    const replyCommit = { path: res.content.path, sha: res.commit.sha, url: res.commit.html_url }
    const db = await getDb()
    await db.collection(C.githubCommits).updateOne({ restaurantId: rid(), messageId }, { $set: { replyCommit } })
    // Pre-register our own commit so the next pull skips it without fetching.
    await db.collection(C.githubCommits).updateOne({ restaurantId: rid(), repo: config.github.repo, sha: res.commit.sha }, {
      $setOnInsert: { branch: config.github.branch, author: { login: null, name: 'OwnerOrbit', email: '' }, message: `${REPLY_PREFIX} reply to ${sha.slice(0, 7)}`, committedAt: new Date(), files: [], text: '', mode: 'brief', status: 'skipped', skipReason: 'our own reply commit', pulledAt: new Date(), url: res.commit.html_url },
    }, { upsert: true })
    return replyCommit
  }

  /** Write a chat message as a commit (what Saddiq's side does; also handy for demos). */
  async sendMessage(text: string) {
    if (!text.trim()) throw new Error('empty message')
    const name = `${config.github.messagesDir}/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    const res = await this.gh<{ commit: { sha: string } }>(`/repos/${config.github.repo}/contents/${name}`, {
      method: 'PUT', body: { message: `message: ${text.slice(0, 60)}`, content: Buffer.from(text).toString('base64'), branch: config.github.branch },
    })
    return { path: name, sha: res.commit.sha }
  }

  /** Re-queue an already-pulled commit (e.g. after fixing a principal mapping). */
  async replay(shaPrefix: string) {
    const db = await getDb()
    const coll = db.collection<CommitDoc>(C.githubCommits)
    const doc = await coll.findOne({ restaurantId: rid(), repo: config.github.repo, sha: { $regex: `^${shaPrefix.replace(/[^0-9a-f]/gi, '')}` } })
    if (!doc) throw new Error(`no pulled commit ${shaPrefix}`)
    const who = await this.principalFor(doc.author)
    if (!who) throw new Error(`author ${doc.author.login ?? doc.author.email} is not mapped to a principal`)
    const messageId = `github:${doc.sha}:replay:${Date.now()}`
    await this.enqueueFn({ from: who.phone, text: doc.text, messageId, channel: doc.mode === 'message' ? 'github-message' : 'github', chat: imessageChat(who.phone) })
    await coll.updateOne({ _id: doc._id }, { $set: { status: 'queued', messageId, principal: normalizeHandle(who.phone) }, $unset: { skipReason: '' } })
    return { sha: doc.sha.slice(0, 7), messageId }
  }
}

/** What the agent reads: commit header + every changed text file in full, with the diff for context. */
export function composeText(c: Pick<CommitDoc, 'repo' | 'sha' | 'author' | 'message' | 'files'>) {
  const parts = [
    `[GitHub update ${c.repo}@${c.sha.slice(0, 7)} by ${c.author.name}${c.author.login ? ` (@${c.author.login})` : ''}]`,
    `Commit message: ${c.message.trim()}`,
    'Treat the text below as instructions/briefing from this person. Analyse it against the current restaurant state, objectives and playbooks; make the changes it asks for with your skill tools (verified on the live dashboard); and end your reply with "Suggested next actions:" as a short numbered list.',
  ]
  for (const f of c.files) {
    if (f.status === 'removed') { parts.push(`--- ${f.path} (deleted)`); continue }
    if (f.text !== null) parts.push(`--- ${f.path} (${f.status})\n${f.text}`)
    if (f.patch && f.status === 'modified') parts.push(`--- what changed in ${f.path}\n${f.patch}`)
  }
  const s = parts.join('\n\n')
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + '\n…(truncated)' : s
}

/** BlueBubbles direct-chat guid, so the owner gets the analysis (and any YES prompt) on iMessage. */
export const imessageChat = (phone: string) => (/^\+?\d{10,15}$/.test(phone.replace(/[\s()-]/g, '')) ? `iMessage;-;${phone.replace(/[\s()-]/g, '')}` : null)

/** Copies the worker's result for a `github:` message back onto its commit document. */
export async function recordCommitResult(messageId: string, r: { status: 'done' | 'failed' | 'processing'; reply?: string; results?: unknown[]; planner?: string; error?: string }) {
  if (!messageId.startsWith('github:')) return
  const db = await getDb()
  await db.collection(C.githubCommits).updateOne({ restaurantId: rid(), messageId }, {
    $set: { status: r.status, ...(r.reply !== undefined && { reply: r.reply }), ...(r.results && { results: r.results }), ...(r.planner && { planner: r.planner }), ...(r.error && { error: r.error }), ...(r.status !== 'processing' && { processedAt: new Date() }) },
  })
}

/** GitHub push webhook signature (X-Hub-Signature-256). */
export function validSignature(raw: string, header: string | undefined, secret: string) {
  if (!secret || !header?.startsWith('sha256=')) return false
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'))
  const got = Buffer.from(header)
  return want.length === got.length && timingSafeEqual(want, got)
}
