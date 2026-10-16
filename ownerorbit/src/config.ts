import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Minimal .env loader so the package has no dotenv dependency.
for (const f of ['.env.local', '.env']) {
  const p = resolve(process.cwd(), f)
  if (!existsSync(p)) continue
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}

const env = (k: string, d = '') => process.env[k] ?? d

export type Role = 'owner' | 'manager' | 'staff'

function json<T>(k: string, d: T): T {
  try { return JSON.parse(env(k)) as T } catch { return d }
}

function principals(): Record<string, Role> {
  try { return JSON.parse(env('OWNERORBIT_PRINCIPALS', '{}')) } catch { return {} }
}

export const config = {
  sandboxUrl: env('SANDBOX_URL', 'https://orders-dashboard-eight-sepia.vercel.app').replace(/\/$/, ''),
  sandboxApi: env('SANDBOX_API', 'auto') as 'live' | 'isolated' | 'auto',
  headless: env('HEADLESS', 'true') !== 'false',
  dataDir: resolve(env('OWNERORBIT_DATA', '.data')),
  profileDir: resolve(env('OWNERORBIT_PROFILE', '.data/browser-profile')),
  principals: principals(),
  bluebubbles: { url: env('BLUEBUBBLES_URL').replace(/\/$/, ''), password: env('BLUEBUBBLES_PASSWORD'), webhookSecret: env('BLUEBUBBLES_WEBHOOK_SECRET') },
  /**
   * real  = send replies through the BlueBubbles server at BLUEBUBBLES_URL.
   * mock  = a BlueBubbles-compatible stand-in inside this server (/mock-bluebubbles) + the /phone demo UI.
   * auto  = real when BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD are set, otherwise mock.
   * Chats whose guid starts with "mock;" (the /phone UI) always use the mock, so a demo never texts a real number.
   */
  bluebubblesMode: env('BLUEBUBBLES_MODE', 'auto') as 'auto' | 'real' | 'mock',
  /** Number the /phone demo texts from (registered as owner automatically while mock is active). */
  demoPhone: env('DEMO_PHONE', '+15550001234'),
  /** Abdullah's browser-exec service (team repo main, browser-exec/). Empty = use the built-in skills only. */
  browserExecUrl: env('BROWSER_EXEC_URL').replace(/\/$/, ''),
  port: Number(env('PORT', '8787')),
  /** agent = grammar first, Claude Haiku agent loop for everything else (the default). */
  planner: env('PLANNER', 'agent') as 'rules' | 'llm' | 'hybrid' | 'agent',
  model: env('OWNERORBIT_MODEL', 'claude-opus-5-5'),
  agentModel: env('OWNERORBIT_AGENT_MODEL', 'claude-haiku-5-5'),
  /** Tenant scope for every MongoDB read/write (matches the dashboard's RESTAURANT_ID). */
  restaurantId: env('RESTAURANT_ID', 'falafel-flare'),
  /** Process iMessages through the MongoDB inbox (inbound_messages) instead of inline. */
  inbox: env('OWNERORBIT_INBOX', 'on') !== 'off',
  /** Text back unknown numbers ("not on the staff list")? Off by default: strangers get silence, the attempt is still logged. */
  replyToUnknown: env('REPLY_TO_UNKNOWN', 'false') === 'true',
  anthropicKey: env('ANTHROPIC_API_KEY'),
  mongo: { uri: env('MONGODB_URI'), db: env('MONGODB_DB', 'ownerorbit') },
  raindropKey: env('RAINDROP_WRITE_KEY'),
  /** Steps touching more than this many entities need a YES. */
  bulkConfirmThreshold: Number(env('BULK_CONFIRM_THRESHOLD', '5')),
  /** Read iMessages the team harness logged in audit_events: fallback (only what its parser couldn't handle) | all | off. */
  harnessBridge: env('HARNESS_BRIDGE', 'fallback') as 'fallback' | 'all' | 'off',
  /** Where the harness logs iMessages (the eval suite points this at a scratch collection). */
  harnessEventsCollection: env('HARNESS_EVENTS_COLLECTION', 'audit_events'),
  /** GitHub → MongoDB → agent: the repo Saddiq's side commits instructions to. */
  github: {
    repo: env('GITHUB_REPO'),
    branch: env('GITHUB_BRANCH', 'main'),
    /** Only changes under these path prefixes count (comma-separated; empty = whole repo). */
    paths: env('GITHUB_PATHS').split(',').map((s) => s.trim().replace(/^\/+/, '')).filter(Boolean),
    /** Files added here are chat messages (one per file, handled exactly like an iMessage: "yes", "undo" work). */
    messagesDir: env('GITHUB_MESSAGES_DIR', 'messages').replace(/^\/+|\/+$/g, ''),
    /** The agent commits its reply to <repliesDir>/<sha>.md (empty = don't push replies). */
    repliesDir: env('GITHUB_REPLIES_DIR', 'replies').replace(/^\/+|\/+$/g, ''),
    /** Falls back to `gh auth token`. */
    token: env('GITHUB_TOKEN'),
    /** GitHub login or commit email → phone of a principal. Also settable per principal (`principals.github`). */
    principals: json<Record<string, string>>('GITHUB_PRINCIPALS', {}),
    pollMs: Number(env('GITHUB_POLL_MS', '10000')),
    /** Commits to take on the very first pull (older history is ignored). */
    backfill: Number(env('GITHUB_BACKFILL', '1')),
    webhookSecret: env('GITHUB_WEBHOOK_SECRET'),
    /** Warn when a pulled commit touches these files (the harness code the bridge depends on). */
    watchFiles: env('GITHUB_WATCH_FILES', 'harness/src/routes/messages.ts,harness/src/db/mongodb.ts,harness/src/audit/audit.ts,harness/src/adapters/bluebubbles.ts').split(',').map((s) => s.trim()).filter(Boolean),
  },
}

/** Whether replies to this chat go to the in-process BlueBubbles stand-in. */
export function usesMockBluebubbles(chat?: string | null) {
  if (chat?.startsWith('mock;')) return true
  if (config.bluebubblesMode === 'mock') return true
  if (config.bluebubblesMode === 'real') return false
  return !(config.bluebubbles.url && config.bluebubbles.password)
}
