import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelTransport, toolDefinitions } from '../model-client'
import { SizingTools } from '../tools'
import { SessionStore, hash } from '../store'
import { SizingToolError } from '../provenance'
import { scenario } from './fixtures'
import { RawRecommendationSchema } from '../evidence'
import { callRecommend } from '@/lib/api/recommend'
import { sizingRequest } from '../contracts'

const config = { origin: 'https://configiq.test', baseUrl: 'http://model.test:8000/v1', model: 'Qwen/test', apiKey: 'private-key', contextTokens: 4096 }
const signal = () => new AbortController().signal
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('model transport', () => {
  it('tokenizes tools and messages, uses private auth, and preserves call IDs', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ count: 1000 })).mockResolvedValueOnce(Response.json({
      choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'native-call', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Which model?"}' } }] } }],
      usage: { completion_tokens: 25 },
    }))
    vi.stubGlobal('fetch', fetch)
    const result = await createModelTransport(config)([{ role: 'user', content: 'Hello' }], ['ask_user'], signal())
    expect(result.id).toBe('native-call')
    expect(fetch.mock.calls[0][0]).toBe('http://model.test:8000/tokenize')
    const payload = JSON.parse(fetch.mock.calls[1][1].body)
    expect(payload.parallel_tool_calls).toBe(false)
    expect(payload.max_tokens).toBe(512)
    expect(payload.tools[0].function.name).toBe('ask_user')
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer private-key')
  })
  it('rejects context overflow before generating', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ count: 4000 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createModelTransport(config)([], ['ask_user'], signal())).rejects.toThrow(/context budget/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['length', 'stop'])('rejects incomplete or free-form %s responses', async reason => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ count: 100 })).mockResolvedValueOnce(Response.json({
      choices: [{ finish_reason: reason, message: { content: 'Use 500 GPUs' } }], usage: { completion_tokens: 10 },
    })))
    await expect(createModelTransport(config)([], ['ask_user'], signal())).rejects.toThrow(/complete tool decision/)
  })
  it('uses strict object argument definitions', () => {
    const definitions = toolDefinitions(['propose_scenario', 'recommend_configuration'])
    expect(definitions[1].function.parameters.additionalProperties).toBe(false)
    expect(definitions[0].function.parameters.properties).toHaveProperty('scenario')
  })
})

describe('real sizing adapters', () => {
  const raw = { chosen_mode: 'agg', configs: [{ total_gpus_needed: 2, replicas_needed: 1, num_total_gpus: 2,
    tp: 2, pp: 1, dp: 1, ttft: 200, tpot: 20, concurrency: 8, tokens_per_second: 400, memory: 18 }] }
  function setup(data: unknown = raw) {
    vi.stubEnv('AISIMULATORS_GATEWAY_URL', 'http://gateway.test')
    const session = new SessionStore().create()
    session.scenario = scenario; session.approved = true; session.revision = 1
    const fetch = vi.fn().mockResolvedValue(Response.json(data))
    vi.stubGlobal('fetch', fetch)
    return { session, fetch, tools: new SizingTools(session, signal()) }
  }
  it('uses the existing recommendation normalizer and never fills missing latency with zero', async () => {
    const { tools, fetch } = setup()
    const result = await tools.execute('recommend_configuration', { system: 'l4' })
    expect(result.metrics.gpus.value).toBe(2)
    expect(result.metrics.ttft.value).toBe(200)
    expect(result.metrics.latency.value).toBeNull()
    expect(result.meetsConstraints).toBe('yes')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ system: 'l4', target_concurrency: 8 })
  })
  it('rejects unapproved or out-of-scope tools without upstream calls', async () => {
    const { tools, session, fetch } = setup()
    await expect(tools.execute('recommend_configuration', { system: 'unknown' })).rejects.toThrow(/approved scope/)
    session.approved = false
    await expect(tools.execute('recommend_configuration', { system: 'l4' })).rejects.toThrow(/approve/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects inconsistent and malformed topology rather than certifying it', async () => {
    const { tools } = setup({ ...raw, configs: [{ ...raw.configs[0], total_gpus_needed: 9 }] })
    await expect(tools.execute('recommend_configuration', { system: 'l4' })).rejects.toThrow(/topology/)
    expect(() => RawRecommendationSchema.parse({ configs: [{ total_gpus_needed: '2' }] })).toThrow()
  })
  it.each(['recommend_configuration', 'inspect_memory'] as const)('rejects contradictory HTTP-200 failure evidence for %s', async name => {
    const data = name === 'recommend_configuration' ? raw : {
      total_gpu_capacity_bytes: 24e9, total_kv_size_bytes: 2e9, kv_size_per_token_bytes: 1024, total_kv_size_tokens: 4096,
      memory_breakdown: { weights_bytes: 16e9, activations_bytes: 1e9, runtime_overhead_bytes: 0, comm_overhead_bytes: 0 },
    }
    const { tools } = setup({ ...data, status: 'failed', error: { message: 'private failure detail' } })
    const args = name === 'recommend_configuration' ? { system: 'l4' }
      : { system: 'l4', tp_size: 1, pp_size: 1, max_batch_size: 8, max_num_tokens: 4096 }
    await expect(tools.execute(name, args)).rejects.toMatchObject({ receipt: { status: 'error', metrics: {} } })
  })
  it('supports disaggregated topology through the shared normalizer', async () => {
    const { tools } = setup({ chosen_mode: 'disagg_vllm', configs: [{ ...raw.configs[0], total_gpus_needed: 6, replicas_needed: 2,
      prefill_config: { tp: 1, num_workers: 1 }, decode_config: { tp: 2, num_workers: 1 } }] })
    const result = await tools.execute('recommend_configuration', { system: 'l4' })
    expect(result.metrics.gpus.value).toBe(6)
    expect(result.metrics.replicas.value).toBe(2)
    expect(result.warnings.join(' ')).toContain('Disaggregated')
  })
  it('validates raw memory evidence before accepting normalizer defaults', async () => {
    const { tools } = setup({ memory_breakdown: {} })
    await expect(tools.execute('inspect_memory', { system: 'l4', tp_size: 1, pp_size: 1, max_batch_size: 8, max_num_tokens: 4096 })).rejects.toThrow()
  })
  it('rejects oversized simulator responses through the bounded adapter', async () => {
    const { tools } = setup({ ...raw, irrelevant: 'x'.repeat(300 * 1024) })
    await expect(tools.execute('recommend_configuration', { system: 'l4' })).rejects.toThrow(/usable configuration/)
  })
  it('forwards cancellation to recommendation fetch without changing old callers', async () => {
    const { fetch } = setup()
    const abort = new AbortController()
    const response = await callRecommend(sizingRequest(scenario, 'l4'), { signal: abort.signal })
    expect(response.status).toBe('completed')
    abort.abort()
    expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
  })
  it('bounds and normalizes catalog shapes from both gateway generations', async () => {
    const { tools, fetch } = setup()
    fetch.mockReset().mockResolvedValueOnce(Response.json({ models: [scenario.model_path, { id: 'other/model' }] }))
      .mockResolvedValueOnce(Response.json({ systems: [{ id: 'l4', name: 'NVIDIA L4', memory_bytes: 24e9 }] }))
    expect(await tools.search('L4')).toEqual({ models: [], systems: [{ id: 'l4', name: 'NVIDIA L4', memory_bytes: 24e9 }] })
    expect(await tools.resolve(scenario.model_path)).toEqual({ model_path: scenario.model_path, source: 'catalog' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each(['recommend_configuration', 'estimate_configuration', 'inspect_memory'] as const)('captures exact upstream payload provenance for %s', async name => {
    const data = name === 'recommend_configuration' ? raw : name === 'estimate_configuration' ? { ttft: 200, tpot: 20, concurrency: 8 }
      : { total_gpu_capacity_bytes: 24e9, total_kv_size_bytes: 2e9, kv_size_per_token_bytes: 1024, total_kv_size_tokens: 4096,
        memory_breakdown: { weights_bytes: 16e9, activations_bytes: 1e9, runtime_overhead_bytes: 0, comm_overhead_bytes: 0 } }
    const { tools, fetch, session } = setup(data)
    const modelConfig = { architectures: ['QwenForCausalLM'], hidden_size: 4096, private_metadata: 'must not appear in public inputs' }
    session.modelConfigs.set(scenario.model_path, modelConfig)
    vi.stubEnv('CONFIGIQ_AGENT_MODEL_ID', 'Qwen/serving-model')
    vi.stubEnv('CONFIGIQ_AGENT_MODEL_REVISION', 'operator-declared-revision')
    const args = name === 'recommend_configuration' ? { system: 'l4' } : name === 'estimate_configuration'
      ? { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 }
      : { system: 'l4', tp_size: 1, pp_size: 1, max_batch_size: 8, max_num_tokens: 4096 }
    const result = await tools.execute(name, args)
    const payload: Record<string, unknown> = JSON.parse(fetch.mock.calls[0][1].body)
    const { model_config: _config, ...safe } = payload
    expect(result.inputHash).toBe(hash(payload))
    expect(result.inputs).toEqual(safe)
    expect(result.inputs).not.toHaveProperty('model_config')
    expect(JSON.stringify(result)).not.toContain('private_metadata')
    expect(result.provenance).toMatchObject({ contractVersion: '2', promptVersion: '2', payloadCaptured: true,
      modelConfigHash: hash(modelConfig), requestIdSource: name === 'estimate_configuration' ? 'none' : 'configiq_adapter',
      servingModelId: 'Qwen/serving-model', servingModelRevision: 'operator-declared-revision' })
    if (name === 'inspect_memory') {
      expect(result.inputs).toHaveProperty('memory_fraction_kind', 'of_total')
      expect(result.inputs).toHaveProperty('memory_fraction_value', 1)
      expect(result.inputs).not.toHaveProperty('target_concurrency')
      expect(result.metrics.capacity.value).toBe(24e9)
    }
  })
  it('preserves captured payloads for rejected HTTP-200 estimates without leaking upstream details', async () => {
    const { tools, fetch } = setup({ status: 'failed', error: { message: 'private upstream detail' } })
    try {
      await tools.execute('estimate_configuration', { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 })
      expect.fail('Invalid estimate must fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SizingToolError)
      const failure = error as SizingToolError
      expect(failure.receipt.status).toBe('error')
      expect(failure.receipt.provenance?.payloadCaptured).toBe(true)
      expect(failure.receipt.inputHash).toBe(hash(JSON.parse(fetch.mock.calls[0][1].body)))
      expect(JSON.stringify(failure.receipt)).not.toContain('private upstream detail')
      expect(failure.receipt.metrics).toEqual({})
    }
  })
  it('does not certify request-rate capacity when the service omits it', async () => {
    const { tools, session } = setup({ ttft: 200, tpot: 20, concurrency: 8 })
    session.scenario = { ...scenario, target_concurrency: null, target_request_rate: 0.25 }
    const result = await tools.execute('estimate_configuration', { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 })
    expect(result.metrics.requestRate.value).toBeNull()
    expect(result.meetsConstraints).toBe('unknown')
  })
  it('uses observed request rate, not approved target rate, when supplied', async () => {
    const { tools, session } = setup({ ttft: 200, tpot: 20, request_rate: 0.125 })
    session.scenario = { ...scenario, target_concurrency: null, target_request_rate: 0.25 }
    const result = await tools.execute('estimate_configuration', { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 })
    expect(result.metrics.requestRate.value).toBe(0.125)
    expect(result.meetsConstraints).toBe('no')
  })
  it('does not certify missing concurrency from the configured batch size', async () => {
    const { tools } = setup({ ttft: 200, tpot: 20 })
    const result = await tools.execute('estimate_configuration', { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 })
    expect(result.metrics.concurrency.value).toBeNull()
    expect(result.meetsConstraints).toBe('unknown')
  })
  it('captures failed memory defaults without claiming an upstream correlation ID', async () => {
    const { tools, fetch } = setup()
    fetch.mockReset().mockResolvedValue(new Response(null, { status: 422 }))
    await expect(tools.execute('inspect_memory', { system: 'l4', tp_size: 1, pp_size: 1, max_batch_size: 8, max_num_tokens: 4096 }))
      .rejects.toMatchObject({ receipt: { status: 'error', inputs: { memory_fraction_value: 1 },
        provenance: { payloadCaptured: true, requestIdSource: 'configiq_adapter' } } })
  })
  it('marks unsupported prefix estimates as unsent rather than claiming a wire-payload hash', async () => {
    const { tools, session, fetch } = setup()
    session.scenario = { ...scenario, prefix: 100 }
    await expect(tools.execute('estimate_configuration', { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION', receipt: { provenance: { payloadCaptured: false, inputHashSource: 'tool_arguments' } } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['estimate_configuration', 'inspect_memory'] as const)('does not accept late %s evidence after cancellation', async name => {
    vi.stubEnv('AISIMULATORS_GATEWAY_URL', 'http://gateway.test')
    const session = new SessionStore().create(), abort = new AbortController()
    session.scenario = scenario; session.approved = true
    vi.stubGlobal('fetch', vi.fn(async () => { abort.abort(); return Response.json({ ttft: 100, tpot: 20 }) }))
    const tools = new SizingTools(session, abort.signal)
    const args = name === 'estimate_configuration' ? { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 }
      : { system: 'l4', tp_size: 1, pp_size: 1, max_batch_size: 8, max_num_tokens: 4096 }
    await expect(tools.execute(name, args)).rejects.toThrow()
    expect(session.receipts).toHaveLength(0)
  })
})
