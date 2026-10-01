import { z } from 'zod'
import { gatewayTimeoutSeconds } from './timeout'
import { AgentError, configuredUrl } from '@/lib/agent/config'
import { fetchJson } from '@/lib/agent/http'

export const AgentEstimateSchema = z.object({
  model_path: z.string().min(1).max(200), system: z.string().min(1).max(200),
  backend: z.enum(['vllm', 'sglang', 'tensorrt-llm']), backend_version: z.string().nullable(),
  isl: z.number().int().positive(), osl: z.number().int().positive(),
  prefix: z.number().int().nonnegative(),
  tp_size: z.number().int().min(1).max(64), pp_size: z.number().int().min(1).max(64),
  batch_size: z.number().int().min(1).max(1024), model_config: z.record(z.string(), z.unknown()).optional(),
}).strict()
const metric = z.number().nonnegative().nullish()
export const EstimateEvidenceSchema = z.object({
  // The service's EstimateResponse requires both timings. Optional metrics
  // must remain optional, but an empty/error object is never successful evidence.
  ttft: z.number().positive(), tpot: z.number().positive(), request_latency: metric,
  tokens_per_second: metric, memory: metric, concurrency: metric,
  request_rate: metric,
  status: z.enum(['completed', 'success']).optional(),
  error: z.never().optional(), detail: z.never().optional(),
  mode: z.literal('agg').optional(),
  system: z.string().nullish(), backend: z.string().nullish(), backend_version: z.string().nullish(),
  tp: z.number().int().positive().nullish(), pp: z.number().int().positive().nullish(),
})
export async function callEstimate(request: z.infer<typeof AgentEstimateSchema>, signal: AbortSignal,
  options: { onRequest?: (payload: Record<string, unknown>) => void } = {}) {
  signal.throwIfAborted()
  const body = AgentEstimateSchema.parse(request)
  // The current service EstimateRequest has no prefix field. Do not let its
  // permissive request parser silently ignore an approved caching assumption.
  if (body.prefix !== 0) throw new AgentError('UNSUPPORTED_CONFIGURATION', 'Fixed-configuration estimates do not support cached-prefix inputs. Use recommendation sizing for this scenario.', 422)
  const { prefix: _prefix, ...payload } = body
  const serialized = JSON.stringify(payload)
  options.onRequest?.(JSON.parse(serialized) as Record<string, unknown>)
  const data = await fetchJson(`${configuredUrl(process.env.AISIMULATORS_GATEWAY_URL)}/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: serialized, signal: AbortSignal.any([signal, AbortSignal.timeout(gatewayTimeoutSeconds() * 1000)]),
  })
  signal.throwIfAborted()
  const parsed = EstimateEvidenceSchema.safeParse(data)
  if (!parsed.success) throw new AgentError('INVALID_EVIDENCE', 'The estimate service returned invalid or unsupported evidence.', 502)
  const result = parsed.data
  for (const [actual, expected] of [[result.system, body.system], [result.backend, body.backend],
    [result.backend_version, body.backend_version], [result.tp, body.tp_size], [result.pp, body.pp_size]]) {
    if (actual != null && expected != null && actual !== expected) {
      throw new AgentError('INVALID_EVIDENCE', 'The estimate response does not match the requested configuration.', 502)
    }
  }
  return result
}
