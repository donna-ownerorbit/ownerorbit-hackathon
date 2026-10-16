import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Serves /api/* in `npm run dev` with the same handler Vercel uses in production.
function devApi(): Plugin {
  return {
    name: 'dev-api',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '')
      for (const k of ['MONGODB_URI', 'MONGODB_DB', 'RESTAURANT_ID']) if (env[k]) process.env[k] = env[k]
      server.middlewares.use('/api', async (req, res) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const raw = Buffer.concat(chunks).toString()
        const { handle } = await server.ssrLoadModule('/server/api.ts')
        const out = await handle({ method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: raw ? JSON.parse(raw) : undefined })
        res.statusCode = out.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(out.json))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), devApi()],
})
