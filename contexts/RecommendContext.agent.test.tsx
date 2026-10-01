// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RecommendProvider, useRecommend } from './RecommendContext'

afterEach(() => vi.unstubAllGlobals())
it('preserves an imported backend version and fractional request rate without inventing concurrency', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'failed', error: { message: 'fixture' } }))
  vi.stubGlobal('fetch', fetch)
  function Probe() {
    const { startSizing } = useRecommend()
    return <button onClick={() => startSizing({ model_path: 'Qwen/model', system: 'l4', isl: 100, osl: 20, ttft: 1000,
      backend: 'vllm', backend_version: 'pinned-version', target_request_rate: 0.25 })}>Calculate</button>
  }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<RecommendProvider><Probe /></RecommendProvider>))
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => container.querySelector('button')?.click())
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ backend_version: 'pinned-version', target_request_rate: 0.25 })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('target_concurrency')
  } finally { await act(async () => root.unmount()) }
})
