import Raindrop from 'raindrop-ai'
import { config } from '../config.ts'

/**
 * Raindrop: one interaction per inbound iMessage, one tool span per skill step, and an agent
 * signal whenever verification fails or a step errors (that's the eval surface).
 * Everything is a no-op without RAINDROP_WRITE_KEY.
 */
type Interaction = ReturnType<Raindrop['begin']>

let client: Raindrop | null = null
function rd() {
  if (!config.raindropKey) return null
  client ??= new Raindrop({ writeKey: config.raindropKey })
  return client
}

export interface Turn {
  eventId: string
  tool<T>(name: string, input: Record<string, unknown>, fn: () => Promise<T>): Promise<T>
  props(p: Record<string, string | number | boolean | null>): void
  signal(name: string, sentiment: 'POSITIVE' | 'NEGATIVE', properties?: Record<string, unknown>): void
  /** Deterministic evals for this turn → Raindrop signals `eval_<name>_pass|fail` (same shape as browser-exec). */
  evals(list: { name: string; pass: boolean; detail: string }[], props?: Record<string, unknown>): void
  /** Raindrop issue grouping for failures (repeatedly_broken_tool, complete_task_failure, …). */
  diagnose(description: string, category: string, properties?: Record<string, unknown>): void
  finish(output: string): Promise<void>
}

export function beginTurn(opts: { eventId: string; userId: string; convoId?: string; input: string }): Turn {
  const r = rd()
  let it: Interaction | null = null
  try { it = r?.begin({ eventId: opts.eventId, event: 'imessage_command', userId: opts.userId, convoId: opts.convoId, input: opts.input }) ?? null } catch (e) { console.warn('[raindrop]', (e as Error).message) }
  return {
    eventId: opts.eventId,
    async tool(name, input, fn) {
      if (!it) return fn()
      return it.withTool({ name, inputParameters: input }, fn) as Promise<Awaited<ReturnType<typeof fn>>>
    },
    props(p) { try { it?.setProperties(p) } catch { /* ignore */ } },
    signal(name, sentiment, properties) { try { r?.trackSignal({ eventId: opts.eventId, name, type: 'agent', sentiment, properties }) } catch { /* ignore */ } },
    evals(list, props = {}) {
      if (!r) return
      try {
        it?.setProperties({ evals_passed: list.filter((e) => e.pass).length, evals_total: list.length })
        it?.addAttachments([{ type: 'text', name: 'Evals', value: list.map((e) => `${e.pass ? 'PASS' : 'FAIL'}  ${e.name}  (${e.detail})`).join('\n'), role: 'output' }])
        r.trackSignal(list.map((e) => ({
          eventId: opts.eventId, name: `eval_${e.name}_${e.pass ? 'pass' : 'fail'}`, type: 'agent_internal' as const,
          sentiment: e.pass ? ('POSITIVE' as const) : ('NEGATIVE' as const), properties: { eval: e.name, pass: e.pass, detail: e.detail, ...props },
        })))
      } catch (e) { console.warn('[raindrop] evals:', (e as Error).message) }
    },
    diagnose(description, category, properties) {
      try { r?.selfDiagnose({ eventId: opts.eventId, description, category, source: 'ownerorbit-core', properties } as Parameters<Raindrop['selfDiagnose']>[0]) } catch { /* ignore */ }
    },
    async finish(output) { try { await it?.finish({ output }) } catch { /* ignore */ } },
  }
}

export async function flushTracing() { try { await client?.close() } catch { /* ignore */ } }
export const tracingEnabled = () => !!config.raindropKey
