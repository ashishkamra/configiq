import { randomUUID } from 'node:crypto'
import { fetchSizingCatalog, type SizingCatalog } from '@/lib/api/catalog'
import { callRecommend } from '@/lib/api/recommend'
import { callKvCacheCalc } from '@/lib/api/kv-cache-calc'
import { callEstimate } from '@/lib/api/estimate'
import { KvCacheCalcRequestSchema } from '@/lib/api/schemas'
import { AgentError } from './config'
import { publicModelConfig, readJson } from './http'
import { AGENT_PROMPT_VERSION, ReceiptSchema, ToolSchemas, sizingRequest, type Receipt, type ToolName } from './contracts'
import { RawMemorySchema, RawRecommendationSchema, constraints, metric, recommendationMetrics } from './evidence'
import { hash, type Session } from './store'
import { captureRequest, SizingToolError } from './provenance'

export class SizingTools {
  private catalog: SizingCatalog | null = null
  constructor(private readonly session: Session, private readonly signal: AbortSignal) {}
  async getCatalog() { return this.catalog ??= await fetchSizingCatalog(this.signal) }
  async search(query: string) {
    const catalog = await this.getCatalog()
    const search = query.toLowerCase()
    return { models: catalog.models.filter(id => id.toLowerCase().includes(search)).slice(0, 15),
      systems: catalog.systems.filter(s => `${s.id} ${s.name ?? ''}`.toLowerCase().includes(search)).slice(0, 15) }
  }
  async resolve(model: string) {
    const catalog = await this.getCatalog()
    if (catalog.models.includes(model)) return { model_path: model, source: 'catalog' }
    if (!/^[\w-]+\/[\w.-]+$/.test(model)) throw new AgentError('MODEL_UNKNOWN', 'Choose an exact catalog or public Hugging Face model identifier.')
    if (!this.session.modelConfigs.has(model)) {
      if (this.session.modelConfigs.size >= 3) throw new AgentError('MODEL_LIMIT', 'Start a new conversation to resolve more models.')
      const data = await publicModelConfig(model, AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AgentError('MODEL_UNKNOWN', 'Invalid model configuration.')
      this.session.modelConfigs.set(model, data as Record<string, unknown>)
    }
    return { model_path: model, source: 'public_model_config' }
  }
  async validateScenario(model: string, systems: string[]) {
    await this.resolve(model)
    const catalog = await this.getCatalog()
    if (systems.some(id => !catalog.systems.some(s => s.id === id))) throw new AgentError('SYSTEM_UNKNOWN', 'Choose system IDs returned by the catalog.')
  }
  async execute(name: ToolName, args: unknown): Promise<Receipt> {
    const scenario = this.session.scenario
    if (!scenario || !this.session.approved) throw new AgentError('APPROVAL_REQUIRED', 'Review and approve the scenario before sizing.')
    const parsed = ToolSchemas[name].parse(args)
    if (!('system' in parsed)) throw new AgentError('INVALID_TOOL', 'This is not a sizing tool.')
    const base = sizingRequest(scenario, parsed.system)
    const config = this.session.modelConfigs.get(scenario.model_path)
    const receipt: Receipt = { id: randomUUID(), revision: this.session.revision, inputHash: hash({ base, parsed }),
      tool: name, system: parsed.system, timestamp: new Date().toISOString(), requestId: null,
      status: 'success', error: null, metrics: {}, warnings: [], meetsConstraints: 'unknown', inputs: {},
      provenance: { contractVersion: '2', promptVersion: AGENT_PROMPT_VERSION, endpoint: name === 'recommend_configuration' ? 'recommend' : name === 'inspect_memory' ? 'memory' : 'estimate',
        payloadCaptured: false, inputHashSource: 'tool_arguments', requestIdSource: 'none', modelConfigHash: null,
        servingModelId: process.env.CONFIGIQ_AGENT_MODEL_ID || 'Qwen/Qwen3-VL-8B-Instruct-FP8',
        servingModelRevision: process.env.CONFIGIQ_AGENT_MODEL_REVISION || null } }
    const onRequest = (payload: Record<string, unknown>) => captureRequest(receipt, payload)
    try {
      if (name === 'recommend_configuration') {
        const response = await callRecommend({ ...base, ...(config ? { model_config: config } : {}) }, {
          signal: this.signal, validateRaw: data => { RawRecommendationSchema.parse(data) },
          readResponse: response => readJson(response.body, 256 * 1024, this.signal),
          onRequest,
        })
        this.signal.throwIfAborted()
        receipt.requestId = response.requestId
        receipt.provenance!.requestIdSource = 'configiq_adapter'
        if (response.status === 'failed') throw new AgentError(response.error.code, 'Sizing did not return a usable configuration. Check the constraints or retry later.', 502)
        receipt.metrics = recommendationMetrics(response)
        receipt.warnings = response.warnings.map(w => `${w.code}: ${w.message}`.slice(0, 500)).slice(0, 20)
        if (response.mode === 'disagg') receipt.warnings.push('Disaggregated prefill/decode layout. Open the standard sizing result to inspect phase details.')
        receipt.meetsConstraints = constraints(scenario, receipt.metrics)
      } else if (name === 'estimate_configuration') {
        const p = ToolSchemas.estimate_configuration.parse(args)
        const response = await callEstimate({ model_path: scenario.model_path, system: p.system, backend: scenario.backend,
          backend_version: scenario.backend_version, isl: scenario.isl, osl: scenario.osl, prefix: scenario.prefix,
          tp_size: p.tp_size, pp_size: p.pp_size, batch_size: p.batch_size, ...(config ? { model_config: config } : {}) }, this.signal, { onRequest })
        receipt.metrics = { ttft: metric('Time to first token', response.ttft, 'ms'), tpot: metric('Time per output token', response.tpot, 'ms'),
          latency: metric('Request latency', response.request_latency, 'ms'), throughput: metric('Output throughput', response.tokens_per_second, 'tokens/s'),
          memory: metric('Memory per GPU', response.memory, 'GB'), concurrency: metric('Concurrency', response.concurrency, 'requests'),
          requestRate: metric('Request rate', response.request_rate, 'req/s') }
        receipt.meetsConstraints = constraints(scenario, receipt.metrics)
      } else if (name === 'inspect_memory') {
        const p = ToolSchemas.inspect_memory.parse(args)
        if (p.tp_size > 64 || p.pp_size > 64 || p.max_batch_size > 1024) throw new AgentError('INVALID_INPUT', 'Memory configuration exceeds the permitted tool limits.')
        const response = await callKvCacheCalc(KvCacheCalcRequestSchema.parse({ ...p, model_path: scenario.model_path,
          backend: scenario.backend, backend_version: scenario.backend_version, ...(config ? { model_config: config } : {}) }), {
          signal: this.signal, validateRaw: data => { RawMemorySchema.parse(data) },
          readResponse: response => readJson(response.body, 256 * 1024, this.signal),
          onRequest,
        })
        this.signal.throwIfAborted()
        receipt.requestId = response.requestId
        receipt.provenance!.requestIdSource = 'configiq_adapter'
        if (response.status === 'failed') throw new AgentError(response.error.code, 'Memory inspection could not complete.', 502)
        receipt.metrics = { capacity: metric('GPU capacity', response.gpuCapacity.totalBytes, 'bytes'),
          weights: metric('Model weights', response.memoryBreakdown.weightsBytes, 'bytes'),
          kvCache: metric('KV cache capacity', response.kvCache.totalBytes, 'bytes') }
      } else throw new AgentError('INVALID_TOOL', 'Unknown sizing tool.')
      this.signal.throwIfAborted()
      if (!receipt.provenance!.payloadCaptured) throw new AgentError('INVALID_PROVENANCE', 'No upstream payload was captured for this operation.', 502)
      return ReceiptSchema.parse(receipt)
    } catch (error) {
      this.signal.throwIfAborted()
      throw new SizingToolError(receipt, error)
    }
  }
}
