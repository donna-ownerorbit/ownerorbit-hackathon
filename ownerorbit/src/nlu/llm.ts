import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.ts'
import { STORES, type PlanStep, type Snapshot } from '../core/types.ts'
import { fromToolName, jsonSchema, SKILLS, toolName } from '../skills/index.ts'
import type { Focus, Parse } from './parser.ts'

/**
 * Claude as the planner for anything the grammar can't parse. It never touches the browser:
 * it only proposes skill calls, which go through the same validation, permission, confirmation
 * and verification path as rule-parsed plans.
 */
let client: Anthropic | null = null
export const llmAvailable = () => !!config.anthropicKey

const ASK = '__ask_owner'

function tools(): Anthropic.Beta.BetaTool[] {
  return [
    ...SKILLS.map((s) => ({
      name: toolName(s.id),
      description: `${s.description}\nExamples: ${s.examples.slice(0, 4).map((e) => `"${e}"`).join(', ')}`,
      input_schema: jsonSchema(s) as Anthropic.Beta.BetaTool.InputSchema,
    })),
    {
      name: ASK,
      description: 'Ask the owner ONE short clarifying question when the request is ambiguous or missing a required value. Provide options when there is a small set of likely answers.',
      input_schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] },
    },
  ]
}

const SYSTEM = `You are Donna, the operations agent for Falafel Flare, a restaurant. The owner texts you over iMessage. You run their restaurant dashboard by calling skills (tools).

Rules:
- Translate the text into one or more skill calls, in the order they should run. Call several tools in one turn for compound requests.
- Use EXACT names from the live catalog below for items, categories, modifier groups and order numbers. Never invent items.
- Restaurant slang: "86" / "out of" / "unavailable" = sold_out_today; "indefinitely"/"for good" = sold_out; "hide"/"take off the menu" = hidden; "back" / "un-86" = available.
- Prefer reversible actions: "remove X from the menu" means hide, not delete. Only use delete when they say delete.
- If something is genuinely ambiguous or a required value is missing, call ${ASK} instead of guessing.
- If the text is chit-chat or not a dashboard task, reply with one short sentence and call no tools.
Pronoun context (what "it"/"them" refers to): {{FOCUS}}`

export function catalog(s: Snapshot) {
  const byCat = s.categories.map((c) => `## ${c.name} [${c.status}]\n` + s.items.filter((i) => i.categoryId === c.id).map((i) => `- ${i.name} | $${i.price.toFixed(2)} | ${i.status}${i.sizes.length ? ` | sizes: ${i.sizes.map((z) => z.name).join(', ')}` : ''}`).join('\n')).join('\n')
  const groups = s.modifierGroups.map((g) => `- ${g.name} (${g.required ? 'required' : 'optional'}, ${g.min}-${g.max}): ${g.options.map((o) => o.name).join(', ')}`).join('\n')
  const orders = s.orders.filter((o) => ['new', 'preparing', 'ready'].includes(o.status)).map((o) => `- ${o.number} ${o.status} ${o.customer}`).join('\n')
  return `# Live catalog\n${byCat}\n\n# Modifier groups\n${groups}\n\n# Active orders\n${orders || '(none)'}\n\n# Locations\n${STORES.map((x) => `- ${x.name} (id ${x.id})`).join('\n')}\nCurrent: ${s.restaurant.storeId}; accepting orders: ${s.restaurant.accepting}`
}

export async function llmPlan(text: string, snap: Snapshot, focus: Focus): Promise<Parse & { usage?: unknown }> {
  if (!llmAvailable()) return { kind: 'unknown', reason: 'no LLM configured' }
  client ??= new Anthropic({ apiKey: config.anthropicKey })
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: SYSTEM.replace('{{FOCUS}}', JSON.stringify({ items: focus.items, category: focus.category, order: focus.order })) },
    { type: 'text', text: catalog(snap), cache_control: { type: 'ephemeral' } },
  ]
  let res: Anthropic.Beta.BetaMessage
  try {
    res = await client.beta.messages.create({
      model: config.model,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      tools: tools(),
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: text }],
    })
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { kind: 'unknown', reason: 'planner rate-limited, try again in a moment' }
    if (e instanceof Anthropic.APIConnectionError) return { kind: 'unknown', reason: 'planner unreachable' }
    if (e instanceof Anthropic.APIError) return { kind: 'unknown', reason: `planner error ${e.status}` }
    throw e
  }
  if (res.stop_reason === 'refusal') return { kind: 'unknown', reason: 'planner declined' }
  const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
  const ask = calls.find((b) => b.name === ASK)
  if (ask) {
    const a = ask.input as { question: string; options?: string[] }
    return { kind: 'clarify', question: a.question, options: (a.options ?? []).map((o) => ({ label: o, steps: [] })) }
  }
  if (!calls.length) {
    const say = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join(' ').trim()
    return { kind: 'unknown', reason: say || 'no action' }
  }
  const steps: PlanStep[] = calls.map((b) => ({ skill: fromToolName(b.name), input: b.input as Record<string, unknown> }))
  return { kind: 'plan', steps, confidence: 0.8, usage: res.usage }
}
