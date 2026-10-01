import { z } from 'zod'
import { AgentError, LIMITS, type AgentConfig } from './config'
import { ToolSchemas, type ToolName } from './contracts'
import { fetchJson } from './http'

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}
export interface Decision { id: string; name: string; arguments: string; tokens: number }
export type ModelTransport = (messages: ModelMessage[], tools: ToolName[], signal: AbortSignal) => Promise<Decision>

const descriptions: Record<ToolName, string> = {
  search_catalog: 'Discover canonical model and GPU system IDs. Results are bounded; narrow the query if needed.',
  resolve_model: 'Resolve an exact model ID. This does not approve a workload or download model weights.',
  propose_scenario: 'Propose the full workload and candidate scope for human review. Explicitly list every assumed input. Ends the run for approval.',
  ask_user: 'Ask one concise clarifying question. Do not assert calculated results. Ends the run for user input.',
  recommend_configuration: 'Size one approved system with the approved workload. No modified inputs allowed.',
  estimate_configuration: 'Estimate an approved system at fixed aggregate parallelism and batch size. TP/PP at most 64; batch at most 1024. Nonzero cached prefix, explicit MoE dimensions, and disaggregated pools are unsupported; use recommendation instead.',
  inspect_memory: 'Inspect memory on an approved system. TP/PP at most 64; batch at most 1024.',
  compare_results: 'Compare current recommendation receipts by ID. Uses verified metrics and the approved objective.',
  finish: 'Finish using existing current receipt IDs. The application renders all numerical results. Do not supply answer text.',
}
export function toolDefinitions(names: ToolName[]) {
  return names.map(name => ({ type: 'function' as const, function: {
    name, description: descriptions[name], parameters: z.toJSONSchema(ToolSchemas[name]),
  } }))
}
const Call = z.object({ id: z.string().min(1).max(200), type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(16_384) }) })
const Completion = z.object({
  choices: z.array(z.object({ finish_reason: z.string(), message: z.object({ tool_calls: z.array(Call).length(1) }) })).length(1),
  usage: z.object({ completion_tokens: z.number().int().min(0).max(LIMITS.outputTokens) }),
})

export function createModelTransport(config: AgentConfig): ModelTransport {
  return async (messages, names, signal) => {
    const tools = toolDefinitions(names)
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }
    const body = { model: config.model, messages, tools }
    const base = config.baseUrl.replace(/\/v1$/, '')
    const tokenized = z.object({ count: z.number().int().nonnegative() }).parse(await fetchJson(`${base}/tokenize`, {
      method: 'POST', headers, signal, body: JSON.stringify({ ...body, add_generation_prompt: true }),
    }, 128 * 1024))
    if (tokenized.count + LIMITS.outputTokens > config.contextTokens) {
      throw new AgentError('CONTEXT_FULL', 'This request exceeds the assistant context budget. Shorten the request or start a new conversation.')
    }
    const raw = await fetchJson(`${config.baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`, {
      method: 'POST', headers, signal, body: JSON.stringify({ ...body,
        stream: false, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: LIMITS.outputTokens, temperature: 0.2 }),
    }, 64 * 1024)
    const parsed = Completion.safeParse(raw)
    if (!parsed.success || !['tool_calls', 'stop'].includes(parsed.data.choices[0].finish_reason)) {
      throw new AgentError('MODEL_FORMAT', 'The model did not return one complete tool decision.', 502)
    }
    const call = parsed.data.choices[0].message.tool_calls[0]
    return { id: call.id, name: call.function.name, arguments: call.function.arguments, tokens: parsed.data.usage.completion_tokens }
  }
}
