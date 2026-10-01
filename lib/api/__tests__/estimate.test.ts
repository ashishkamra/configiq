import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentEstimateSchema, EstimateEvidenceSchema, callEstimate } from '../estimate'

const request = {
  model_path: 'Qwen/Qwen3-8B', system: 'l4', backend: 'vllm' as const,
  backend_version: null, isl: 2048, osl: 128, prefix: 0,
  tp_size: 1, pp_size: 1, batch_size: 8,
}
beforeEach(() => vi.stubEnv('AISIMULATORS_GATEWAY_URL', 'http://gateway.test'))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('estimate evidence contract', () => {
  it.each([
    {}, { unrelated: true }, { status: 'failed', error: { code: 'NO_CONFIGURATION' } },
    { ttft: 100 }, { tpot: 20 }, { ttft: null, tpot: 20 },
    { ttft: 0, tpot: 20 }, { ttft: 100, tpot: -1 }, { ttft: '100', tpot: 20 },
    { ttft: NaN, tpot: 20 }, { ttft: 100, tpot: Infinity },
    { ttft: 100, tpot: 20, status: 'failed' },
    { ttft: 100, tpot: 20, error: { message: 'Rejected' } },
    { ttft: 100, tpot: 20, detail: 'Rejected' },
  ])('rejects invalid evidence %j', response => {
    expect(EstimateEvidenceSchema.safeParse(response).success).toBe(false)
  })
  it('requires both positive timing metrics without defaulting optional metrics', () => {
    expect(EstimateEvidenceSchema.parse({ ttft: 100, tpot: 20, serving_config: {} })).toMatchObject({ ttft: 100, tpot: 20 })
    expect(EstimateEvidenceSchema.parse({ ttft: 100, tpot: 20 })).not.toHaveProperty('memory')
  })
})

describe('server estimate adapter', () => {
  it.each([{}, { ttft: 100 }, { status: 'failed', error: { message: 'private upstream detail' }, ttft: 100, tpot: 20 }])('classifies invalid HTTP-200 responses %j', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)))
    await expect(callEstimate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE', status: 502 })
  })
  it('accepts aggregate service responses and preserves missing optional evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ttft: 100, tpot: 20, mode: 'agg', system: 'l4', concurrency: null, memory: null })))
    const result = await callEstimate(request, new AbortController().signal)
    expect(result).toMatchObject({ ttft: 100, tpot: 20, concurrency: null, memory: null })
    expect(result.tokens_per_second).toBeUndefined()
  })
  it.each([
    { mode: 'disagg', prefill_config: {}, decode_config: {} },
    { mode: 'other' }, { system: 'h100' }, { backend: 'sglang' }, { tp: 2 },
  ])('rejects mismatched or unsupported scope %j', async extra => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ttft: 100, tpot: 20, ...extra })))
    await expect(callEstimate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  })
  it('does not accept unimplemented MoE and disaggregated request fields', () => {
    expect(AgentEstimateSchema.safeParse({ ...request, moe_ep_size: 8 }).success).toBe(false)
    expect(AgentEstimateSchema.safeParse({ ...request, mode: 'disagg' }).success).toBe(false)
  })
  it('does not let the gateway silently ignore nonzero cached prefix', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(callEstimate({ ...request, prefix: 100 }, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('passes a detached exact wire payload to observers without permitting mutation of the request', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ttft: 100, tpot: 20 }))
    vi.stubGlobal('fetch', fetch)
    await callEstimate(request, new AbortController().signal, { onRequest: payload => { payload.batch_size = 999 } })
    expect(JSON.parse(fetch.mock.calls[0][1].body).batch_size).toBe(8)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('prefix')
  })
  it('classifies upstream rejection and honours caller cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 422 })))
    await expect(callEstimate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'NO_CONFIGURATION' })
    const abort = new AbortController(); abort.abort()
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => Promise.reject(init.signal?.reason)))
    await expect(callEstimate(request, abort.signal)).rejects.toThrow()
  })
})
