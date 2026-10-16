import { config } from '../config.ts'
import { C, getDb } from '../db/mongo.ts'
import { GitHubSync, githubConfigured } from '../github/sync.ts'

/**
 * MongoDB ← GitHub.
 *   npm run github -- pull            pull new commits into github_commits and queue them for the agent
 *   npm run github -- pull --dry      pull into MongoDB only (no agent run)
 *   npm run github -- replay <sha>    queue an already-pulled commit again
 *   npm run github -- send <text>     commit a chat message to messages/ (what Saddiq's side does)
 *   npm run github -- status          recent commits and what the agent did with them
 */
const [cmd = 'status', arg] = process.argv.slice(2)
if (!githubConfigured()) throw new Error('Set GITHUB_REPO=owner/name in .env.local')
const sync = new GitHubSync()
if (cmd === 'pull') console.log(JSON.stringify(await sync.pull({ execute: !process.argv.includes('--dry') }), null, 1))
else if (cmd === 'replay') console.log(await sync.replay(arg ?? ''))
else if (cmd === 'send') console.log(await sync.sendMessage(process.argv.slice(3).join(' ')))
const db = await getDb()
console.log(`\n${config.github.repo}@${config.github.branch}${config.github.paths.length ? ` (paths: ${config.github.paths.join(', ')})` : ''}`)
for (const d of await db.collection(C.githubCommits).find({ repo: config.github.repo }).sort({ committedAt: -1 }).limit(10).toArray()) {
  console.log(`${String(d.sha).slice(0, 7)} ${String(d.status).padEnd(10)} ${d.author.login ?? d.author.email}: ${String(d.message).split('\n')[0]}${d.skipReason ? `  [${d.skipReason}]` : ''}`)
  if (d.reply) console.log(`    ↳ ${String(d.reply).replace(/\n/g, '\n      ')}`)
}
process.exit(0)
