import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handle } from '../server/api.js'

// All /api/* requests are rewritten here (see vercel.json) with the original path in ?path=.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = String(req.query.path ?? '')
  const out = await handle({ method: req.method ?? 'GET', path, body: req.body })
  res.setHeader('Cache-Control', 'no-store')
  res.status(out.status).json(out.json)
}
