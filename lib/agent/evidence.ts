import { z } from 'zod'
import type { RecommendResult } from '@/lib/api/recommend'
import type { Receipt, Scenario } from './contracts'
import { AgentError } from './config'

const positive = z.number().positive()
const dimension = z.number().int().positive()
const optionalMetric = z.number().nonnegative().nullish()
const worker = z.object({ tp: dimension, pp: dimension.optional(), dp: dimension.optional(), cp: dimension.optional(), num_workers: dimension,
  moe_tp: dimension.nullish(), moe_ep: dimension.nullish() })
export const RawRecommendationSchema = z.object({
  status: z.enum(['completed', 'success']).optional(), error: z.never().optional(), detail: z.never().optional(),
  configs: z.array(z.object({
    total_gpus_needed: dimension, replicas_needed: dimension, num_total_gpus: dimension.optional(),
    tp: dimension.optional(), pp: dimension.optional(), dp: dimension.optional(), cp: dimension.optional(),
    ttft: optionalMetric, tpot: optionalMetric, request_latency: optionalMetric,
    concurrency: optionalMetric, memory: optionalMetric, tokens_per_second: optionalMetric,
    request_rate: optionalMetric, tokens_per_second_per_gpu: optionalMetric, tokens_per_second_per_user: optionalMetric,
    prefill_config: worker.nullish(), decode_config: worker.nullish(), encode_config: worker.nullish(),
  })).max(20), chosen_mode: z.string().optional(),
})
export const RawMemorySchema = z.object({
  status: z.enum(['completed', 'success']).optional(), error: z.never().optional(), detail: z.never().optional(),
  total_gpu_capacity_bytes: positive, total_kv_size_bytes: z.number().nonnegative(),
  kv_size_per_token_bytes: z.number().nonnegative(), total_kv_size_tokens: z.number().nonnegative(),
  memory_breakdown: z.object({ weights_bytes: z.number().nonnegative(), activations_bytes: z.number().nonnegative(),
    runtime_overhead_bytes: z.number().nonnegative(), comm_overhead_bytes: z.number().nonnegative() }),
})
const observed = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
export const metric = (label: string, value: number | null | undefined, unit: string) => ({ label, value: observed(value), unit })

export function recommendationMetrics(result: RecommendResult): Receipt['metrics'] {
  const r = result.recommendation
  if (result.mode === 'disagg' && (!result.phases.prefill || !result.phases.decode)) {
    throw new AgentError('INVALID_EVIDENCE', 'The service returned an incomplete disaggregated topology.', 502)
  }
  for (const value of [r.gpusNeeded, r.gpusPerReplica, r.replicasNeeded]) dimension.parse(value)
  if (r.gpusPerReplica * r.replicasNeeded !== r.gpusNeeded || result.warnings.some(w => w.code === 'GPU_TOPOLOGY_MISMATCH')) {
    throw new AgentError('INVALID_EVIDENCE', 'The service returned inconsistent GPU topology.', 502)
  }
  const metrics: Receipt['metrics'] = {
    gpus: metric('Total GPUs', r.gpusNeeded, 'GPUs'), replicas: metric('Replicas', r.replicasNeeded, 'replicas'),
    gpusPerReplica: metric('GPUs per replica', r.gpusPerReplica, 'GPUs'),
    ttft: metric('Time to first token', result.performance.ttftLatencyMs, 'ms'),
    tpot: metric('Time per output token', result.performance.tpotMs, 'ms'),
    latency: metric('Request latency', result.performance.requestLatencyMs, 'ms'),
    concurrency: metric('Supported concurrency', result.performance.concurrency, 'requests'),
    requestRate: metric('Request rate', result.throughput.requestsPerSecond, 'req/s'),
    throughput: metric('Output throughput', result.throughput.tokensPerSecond, 'tokens/s'),
    memory: metric('Peak memory per GPU', result.memory.value, result.memory.unit),
  }
  for (const [name, phase] of Object.entries(result.phases)) {
    if (!phase) continue
    dimension.parse(phase.workers); dimension.parse(phase.gpusPerWorker)
    metrics[`${name}_workers`] = metric(`${name} workers per replica`, phase.workers, 'workers')
    metrics[`${name}_gpus`] = metric(`${name} GPUs per worker`, phase.gpusPerWorker, 'GPUs')
    metrics[`${name}_tp`] = metric(`${name} tensor parallelism`, phase.tensorParallelSize, 'ranks')
    metrics[`${name}_pp`] = metric(`${name} pipeline parallelism`, phase.pipelineParallelSize, 'stages')
  }
  return metrics
}
export function constraints(scenario: Scenario, metrics: Receipt['metrics']): Receipt['meetsConstraints'] {
  const checks: Array<boolean | null> = []
  for (const [key, ceiling] of [['ttft', scenario.ttft], ['tpot', scenario.tpot], ['latency', scenario.request_latency]] as const) {
    if (ceiling === null) continue
    const value = metrics[key]?.value
    checks.push(value == null ? null : value <= ceiling)
  }
  const key = scenario.target_concurrency !== null ? 'concurrency' : 'requestRate'
  const value = metrics[key]?.value
  checks.push(value == null ? null : value >= (scenario.target_concurrency ?? scenario.target_request_rate ?? Infinity))
  return checks.includes(false) ? 'no' : checks.includes(null) ? 'unknown' : 'yes'
}
export function summarize(scenario: Scenario | null, revision: number, receipts: Receipt[]): string {
  const current = receipts.filter(r => r.revision === revision && r.tool === 'recommend_configuration')
  const successful = current.filter(r => r.status === 'success')
  if (!successful.length) return 'No verified recommendation is available. Review the tool outcomes or try the standard sizing form.'
  const complete = scenario?.systems.every(system => current.some(r => r.system === system)) ?? false
  let text = complete ? 'The requested candidates have been evaluated.' : 'This is a partial comparison; not all requested candidates were evaluated.'
  text += ' Values below are AISimulators estimates, not measured hardware benchmarks.'
  if (scenario?.objective === 'satisfy_constraints') return text + ' No optimization winner was requested.'
  const eligible = successful.filter(r => r.meetsConstraints === 'yes')
  const key = scenario?.objective === 'minimize_gpu_count' ? 'gpus' : 'ttft'
  if (!eligible.length || eligible.some(r => r.metrics[key]?.value == null)) return text + ' There is insufficient evidence to rank feasible configurations.'
  const best = Math.min(...eligible.map(r => r.metrics[key].value!))
  let winners = eligible.filter(r => r.metrics[key].value === best)
  if (key === 'gpus' && winners.length > 1 && winners.every(r => r.metrics.ttft?.value != null)) {
    const fastest = Math.min(...winners.map(r => r.metrics.ttft.value!))
    winners = winners.filter(r => r.metrics.ttft.value === fastest)
  }
  return text + ` Best among successfully evaluated, verified feasible candidates: ${winners.map(r => r.system).join(', ')}${winners.length > 1 ? ' (tie)' : ''}. GPU count is not a cost comparison.`
}
