import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { config } from '../src/config.ts'
import { composeText, GitHubSync, imessageChat, validSignature } from '../src/github/sync.ts'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const BRIEF = '# Catering push\nGet catering to $15k/month by Jan 31.\n86 the chicken nuggets until tomorrow.'

function fakeGitHub(calls: string[]) {
  return async (url: string) => {
    calls.push(url)
    const path = url.replace('https://api.github.com', '')
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (path.startsWith('/repos/acme/briefs/commits/abc1234')) {
      return ok({
        sha: 'abc1234def', html_url: 'https://github.com/acme/briefs/commit/abc1234def', author: { login: 'saddiq' },
        commit: { message: 'Catering brief', author: { name: 'Saddiq Jeelani', email: 's@x.com', date: '2026-10-11T20:00:00Z' } },
        files: [
          { filename: 'briefs/catering.md', status: 'modified', additions: 2, deletions: 0, patch: '@@ -1 +1,3 @@\n+86 the chicken nuggets until tomorrow.' },
          { filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '+x' },
          { filename: 'briefs/logo.png', status: 'added', additions: 0, deletions: 0 },
        ],
      })
    }
    if (path.startsWith('/repos/acme/briefs/contents/briefs/catering.md?ref=abc1234def')) return ok({ content: b64(BRIEF), encoding: 'base64' })
    return new Response('not found', { status: 404 })
  }
}

test('a commit becomes full brief text + diff, filtered to watched paths', async () => {
  const saved = { ...config.github }
  Object.assign(config.github, { repo: 'acme/briefs', branch: 'main', paths: ['briefs'] })
  try {
    const calls: string[] = []
    const c = await new GitHubSync(fakeGitHub(calls) as typeof fetch).fetchCommit('abc1234')
    assert.deepEqual(c.files.map((f) => f.path), ['briefs/catering.md', 'briefs/logo.png'])
    assert.equal(c.files[0].text, BRIEF)
    assert.equal(c.files[1].text, null) // binary: never fetched
    assert.equal(c.author.login, 'saddiq')
    assert.match(c.text, /^\[GitHub update acme\/briefs@abc1234 by Saddiq Jeelani \(@saddiq\)\]/)
    assert.match(c.text, /Get catering to \$15k\/month/)
    assert.match(c.text, /what changed in briefs\/catering\.md/)
    assert.match(c.text, /Suggested next actions/)
    assert.ok(!calls.some((u) => u.includes('README')))
  } finally { Object.assign(config.github, saved) }
})

test('compose clips huge briefs', () => {
  const t = composeText({ repo: 'a/b', sha: '1234567890', author: { login: null, name: 'X', email: 'x@y' }, message: 'm', files: [{ path: 'a.md', status: 'added', additions: 1, deletions: 0, patch: null, text: 'y'.repeat(50_000) }] })
  assert.ok(t.length < 20_100)
  assert.match(t, /truncated/)
})

test('GitHub errors surface with status', async () => {
  const saved = { ...config.github }
  Object.assign(config.github, { repo: 'acme/briefs' })
  try {
    await assert.rejects(new GitHubSync((async () => new Response('Bad credentials', { status: 401 })) as typeof fetch).fetchCommit('zzz'), /GitHub 401/)
  } finally { Object.assign(config.github, saved) }
})

test('webhook signatures', () => {
  const raw = '{"ref":"refs/heads/main"}'
  const sig = 'sha256=' + createHmac('sha256', 's3cret').update(raw).digest('hex')
  assert.equal(validSignature(raw, sig, 's3cret'), true)
  assert.equal(validSignature(raw, sig, 'other'), false)
  assert.equal(validSignature(raw, undefined, 's3cret'), false)
  assert.equal(validSignature(raw, sig, ''), false)
})

test('iMessage chat guid for replies', () => {
  assert.equal(imessageChat('+1 (510) 555-0100'), 'iMessage;-;+15105550100')
  assert.equal(imessageChat('someone@example.com'), null)
})
