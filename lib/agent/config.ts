export const LIMITS = {
  runMs: 180_000, queueMs: 15_000, modelMs: 30_000, modelCalls: 8,
  toolCalls: 12, expensiveCalls: 4, outputTokens: 512, runTokens: 4096,
  contextTokens: 4096, activeRuns: 4, queuedRuns: 8, modelConcurrency: 2,
  sizingConcurrency: 2, sessionTtl: 30 * 60_000, proposalTtl: 10 * 60_000,
  sessions: 500, sessionBytes: 256 * 1024, bodyBytes: 32 * 1024,
} as const

export class AgentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message)
    this.name = 'AgentError'
  }
}
export function configuredUrl(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    return url.toString().replace(/\/$/, '')
  } catch { throw new AgentError('NOT_CONFIGURED', 'Agent service configuration is invalid.', 503) }
}
export function agentEnabled() { return process.env.CONFIGIQ_AGENT_ENABLED === 'true' }
export function getAgentConfig() {
  if (!agentEnabled()) throw new AgentError('DISABLED', 'The sizing assistant is not enabled. Use Recommend sizing instead.', 503)
  if (process.env.CONFIGIQ_AGENT_SINGLE_PROCESS !== 'true') {
    throw new AgentError('NOT_CONFIGURED', 'The assistant requires a qualified single-process deployment.', 503)
  }
  const origin = new URL(configuredUrl(process.env.CONFIGIQ_AGENT_ORIGIN)).origin
  const baseUrl = configuredUrl(process.env.CONFIGIQ_AGENT_MODEL_BASE_URL)
  configuredUrl(process.env.AISIMULATORS_GATEWAY_URL)
  const model = process.env.CONFIGIQ_AGENT_MODEL_ID || 'Qwen/Qwen3-VL-8B-Instruct-FP8'
  const apiKey = process.env.CONFIGIQ_AGENT_MODEL_API_KEY
  if (!apiKey || !model || model.length > 200) throw new AgentError('NOT_CONFIGURED', 'The assistant model is not configured.', 503)
  if ((process.env.CONFIGIQ_AGENT_MODEL_REVISION?.length ?? 0) > 200) throw new AgentError('NOT_CONFIGURED', 'The configured model revision is too long.', 503)
  const contextTokens = Number(process.env.CONFIGIQ_AGENT_CONTEXT_TOKENS || LIMITS.contextTokens)
  const concurrency = Number(process.env.CONFIGIQ_AGENT_MODEL_CONCURRENCY || 1)
  if (![4096, 8192].includes(contextTokens) || ![1, 2].includes(concurrency)) {
    throw new AgentError('NOT_CONFIGURED', 'Use a qualified context limit (4096 or 8192) and model concurrency (1 or 2).', 503)
  }
  return { origin, baseUrl, model, apiKey, contextTokens }
}
export type AgentConfig = ReturnType<typeof getAgentConfig>
