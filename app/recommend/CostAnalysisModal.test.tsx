// @vitest-environment happy-dom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RecommendResult } from '@/lib/api/recommend';
import { callRecommend } from '@/lib/api/recommend';
import type { FrontierModel } from '@/lib/hooks/useCostings';
import { CostAnalysisModal } from './CostAnalysisModal';

const result: RecommendResult = {
  requestId: 'first', status: 'completed', mode: 'agg',
  recommendation: { gpusNeeded: 9, gpusPerReplica: 9, totalGpus: 9, replicasNeeded: 1,
    tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1, contextParallelSize: 1,
    moeTensorParallelSize: null, moeExpertParallelSize: null, batchSize: null },
  phases: { prefill: null, decode: null, encode: null },
  performance: { ttftLatencyMs: 10, tpotMs: 20, requestLatencyMs: 100, concurrency: 1000 },
  throughput: { tokensPerSecond: 100, tokensPerSecondPerGpu: 10, tokensPerSecondPerUser: 10,
    requestsPerSecond: 1, inputTokensPerSecond: 900, outputTokensPerSecond: 100, totalTokensPerSecond: 1000 },
  memory: { value: 20, unit: 'GB' },
  metadata: { modelPath: 'example/model', system: 'sized-system', inputTokens: 1000,
    outputTokens: 200, targetTtftMs: 500, durationMs: 100 }, warnings: [],
};

const models: FrontierModel[] = [
  { id: 'provider/model-a', name: 'Model A', provider: 'Vendor', tier: 'fast', price_per_m_input: 2,
    price_per_m_cached_input: null, price_per_m_output: 10, context_window: null, updated_at: null },
  { id: 'bad', name: 'Broken', provider: 'Vendor', tier: 'fast', price_per_m_input: -1,
    price_per_m_output: NaN, context_window: null, updated_at: null },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onClose = vi.fn();

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onClose.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function render(overrides: Partial<React.ComponentProps<typeof CostAnalysisModal>> = {}) {
  await act(async () => root.render(<CostAnalysisModal result={result} isOpen onClose={onClose}
    gpusPerNode={4} costingsEnabled models={models} source="merged" stale={false}
    updatedAt="2026-09-01" loading={false} error={null} {...overrides} />));
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input ${id}`);
  return element;
}

async function fill(id: string, value: string) {
  await act(async () => {
    const el = input(id);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('CostAnalysisModal', () => {
  it('transfers completed sizing, scaled replica throughput and request token lengths into cost calculations', async () => {
    vi.stubEnv('AISIMULATORS_GATEWAY_URL', 'http://test-gateway');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      chosen_mode: 'agg', configs: [{
        total_gpus_needed: 12, replicas_needed: 3, num_total_gpus: 4,
        tp: 4, pp: 1, dp: 1, cp: 1, concurrency: 20, request_rate: 4,
        input_tokens_per_second: 1200, output_tokens_per_second: 200,
        total_tokens_per_second: 1400, tokens_per_second: 200,
        tokens_per_second_per_user: 25,
      }],
    }) }));
    const sized = await callRecommend({
      model_path: 'sized/model', system: 'gpu-system', backend: 'vllm',
      isl: 300, osl: 50, ttft: 1000, tpot: 30, target_concurrency: 20,
      prefix: 0, database_mode: 'HYBRID', top_n: 5,
    });
    expect(sized.status).toBe('completed');
    if (sized.status !== 'completed') return;

    await render({ result: sized, gpusPerNode: 4 });
    expect(input('cost-gpusPerNode').value).toBe('4');
    expect(input('cost-nodes').value).toBe('3');
    expect(document.body.textContent).toContain('sized/model');
    expect(document.body.textContent).toContain('gpu-system');
    expect(document.body.textContent).toContain('300 input / 50 output tokens');
    expect(document.body.textContent).toContain('60 supported concurrent users');
    expect(document.body.textContent).toContain('3,600 input tokens/s');
    expect(document.body.textContent).toContain('600 output tokens/s');
    expect(document.body.textContent).toContain('4,200 total tokens/s');
    expect(document.body.textContent).toContain('25 output tokens/s/user');
    await fill('cost-costPerNodeMonth', '1000');
    expect(document.body.textContent).toContain('$3,000');
    expect(document.body.textContent).toContain(`${(4200 * 30.44 * 86400 / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M tokens`);

    const changed = { ...sized, requestId: 'second',
      recommendation: { ...sized.recommendation, gpusNeeded: 20 },
      metadata: { ...sized.metadata, modelPath: 'new/model', inputTokens: 600, outputTokens: 100 },
      throughput: { ...sized.throughput, inputTokensPerSecond: 7200, outputTokensPerSecond: 1200,
        totalTokensPerSecond: 8400, tokensPerSecondPerUser: 30 },
      performance: { ...sized.performance, concurrency: 90 },
    };
    await render({ result: changed, gpusPerNode: 4 });
    expect(input('cost-nodes').value).toBe('5');
    expect(input('cost-costPerNodeMonth').value).toBe('1000');
    expect(document.body.textContent).toContain('new/model');
    expect(document.body.textContent).toContain('600 input / 100 output tokens');
    expect(document.body.textContent).toContain('7,200 input tokens/s');
    expect(document.body.textContent).toContain('1,200 output tokens/s');
    expect(document.body.textContent).toContain('8,400 total tokens/s');
    expect(document.body.textContent).toContain('90 supported concurrent users');
    expect(document.body.textContent).toContain('$5,000');
  });

  it('opens, closes and retains local state while updating to a new sizing result', async () => {
    await render({ isOpen: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(input('cost-gpusPerNode').value).toBe('4');
    expect(input('cost-nodes').value).toBe('3');
    await fill('cost-costPerNodeMonth', '1250');
    await fill('cost-gpusPerNode', '8');
    expect(input('cost-nodes').value).toBe('2');
    await fill('cost-nodes', '5');
    await fill('cost-gpusPerNode', '3');
    expect(input('cost-nodes').value).toBe('5');
    const close = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Close');
    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalled();
    await render({ isOpen: false });
    await render({ result: { ...result, requestId: 'second', recommendation: { ...result.recommendation, gpusNeeded: 19 } }, gpusPerNode: 2 });
    expect(input('cost-nodes').value).toBe('7');
    expect(input('cost-gpusPerNode').value).toBe('3');
    expect(input('cost-costPerNodeMonth').value).toBe('1250');
  });

  it('uses the new system catalog topology after re-sizing different hardware', async () => {
    await render();
    await fill('cost-gpusPerNode', '3');
    await fill('cost-nodes', '9');
    await fill('cost-costPerNodeMonth', '1200');
    await render({ result: { ...result, requestId: 'new-system',
      metadata: { ...result.metadata, system: 'different-system' },
      recommendation: { ...result.recommendation, gpusNeeded: 15 },
    }, gpusPerNode: 5 });
    expect(input('cost-gpusPerNode').value).toBe('5');
    expect(input('cost-nodes').value).toBe('3');
    expect(input('cost-costPerNodeMonth').value).toBe('1200');
    expect(document.body.textContent).toContain('different-system');
  });

  it('does not display pricing when disabled and provides settings navigation', async () => {
    await render({ costingsEnabled: false });
    expect(document.body.textContent).toContain('API pricing is disabled');
    expect(document.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(document.getElementById('cost-model-search')).toBeNull();
    expect(document.body.textContent).toContain('Enter node cost');
  });

  it('blocks cost at demand when monthly or peak demand exceeds capacity', async () => {
    await render();
    await fill('cost-costPerNodeMonth', '1000');
    await fill('cost-users', '100000');
    expect(document.body.textContent).toContain('Monthly demand exceeds');
    expect(document.body.textContent).toContain('Cost at demand is unavailable');
    const metric = Array.from(document.querySelectorAll('strong')).find(e => e.parentElement?.textContent?.includes('Self-hosted USD / 1M at demand'));
    expect(metric?.textContent).toBe('Unavailable');
  });

  it('searches valid model prices, selects a model and keeps the choice across source updates', async () => {
    await render();
    await fill('cost-costPerNodeMonth', '1000');
    await fill('cost-model-search', 'vendor');
    expect(document.querySelectorAll('.pf-v5-c-check')).toHaveLength(1);
    const checkbox = input('cost-model-provider/model-a');
    await act(async () => checkbox.click());
    expect(document.body.textContent).toContain('cache price unavailable; regular input used');
    expect(document.body.textContent).toContain('Model A · Vendor');
    await render({ models: [] });
    expect(document.body.textContent).toContain('price unavailable');
    await render({ models: [{ ...models[0], price_per_m_input: 4 }] });
    expect(document.body.textContent).toContain('Model A · Vendor');
    expect(document.body.textContent).toContain('$4.00');
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove provider/model-a"]')?.click());
    expect(Array.from(document.querySelectorAll('table caption')).some(c => c.textContent?.includes('API comparison'))).toBe(false);
  });

  it('excludes priced models whose published context is shorter than the sized request', async () => {
    await render({ models: [
      { ...models[0], id: 'too-short', context_window: 1199 },
      { ...models[0], id: 'fits', context_window: 1200 },
    ] });
    await fill('cost-model-search', 'Vendor');
    expect(document.getElementById('cost-model-too-short')).toBeNull();
    expect(document.getElementById('cost-model-fits')).not.toBeNull();
  });

  it('validates blank and nonfinite fields and handles missing throughput without charts', async () => {
    await render({ result: { ...result, throughput: { ...result.throughput, inputTokensPerSecond: null } } });
    await fill('cost-users', '');
    expect(input('cost-users').getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).not.toContain('Cost per million vs utilization');
    await fill('cost-users', '20');
    await fill('cost-costPerNodeMonth', '10');
    expect(document.body.textContent).toContain('Missing input throughput');
    expect(document.body.textContent).not.toContain('Cost per million vs utilization');
  });

  it('rejects undersized nodes and percentages outside bounds, and omits charts for zero cost', async () => {
    await render({ gpusPerNode: null });
    expect(input('cost-gpusPerNode').value).toBe('8');
    expect(input('cost-nodes').value).toBe('2');
    await fill('cost-nodes', '1');
    expect(document.body.textContent).toContain('At least 2 nodes');
    await fill('cost-nodes', '2');
    await fill('cost-cacheHitPct', '101');
    expect(input('cost-cacheHitPct').getAttribute('aria-invalid')).toBe('true');
    await fill('cost-cacheHitPct', '0');
    await fill('cost-costPerNodeMonth', '0');
    expect(document.body.textContent).toContain('$0');
    expect(document.body.textContent).not.toContain('Cost per million vs utilization');
    await fill('cost-costPerNodeMonth', '2000');
    expect(document.body.textContent).toContain('Cost per million vs utilization');
    expect(document.body.textContent).toContain('Self-hosted cost curve samples');
  });

  it('labels free and above-capacity API break-even without publishing old loading prices', async () => {
    const free = { ...models[0], id: 'free', name: 'Free API', price_per_m_input: 0, price_per_m_output: 0 };
    const cheap = { ...models[0], id: 'cheap', name: 'Cheap API', price_per_m_input: 0.0001, price_per_m_output: 0.0001 };
    await render({ models: [free, cheap], stale: true });
    await fill('cost-costPerNodeMonth', '100000');
    await fill('cost-model-search', 'API');
    await act(async () => input('cost-model-free').click());
    await act(async () => input('cost-model-cheap').click());
    expect(document.body.textContent).toContain('No break-even (free API)');
    expect(document.body.textContent).toContain('beyond capacity');
    expect(document.body.textContent).toContain('stale pricing');
    await render({ models: [free, cheap], loading: true });
    expect(document.body.textContent).toContain('Loading API prices');
    expect(document.querySelector('table caption')?.textContent).not.toContain('API comparison');
  });
});
