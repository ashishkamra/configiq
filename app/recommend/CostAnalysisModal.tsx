'use client';

import * as React from 'react';
import { Button, Checkbox, Modal, TextInput } from '@patternfly/react-core';
import { Chart, ChartAxis, ChartBar, ChartLine } from '@patternfly/react-charts';
import type { RecommendResult } from '@/lib/api/recommend';
import type { FrontierModel } from '@/lib/hooks/useCostings';
import type { PricingSource } from '@/contexts/SettingsContext';
import { compareApiModels, computeCostScenario, costCurve } from '@/lib/recommend-cost/economics';
import type { ApiComparison, CostScenarioInput } from '@/lib/recommend-cost/economics';
import styles from './CostAnalysisModal.module.css';

interface CostAnalysisModalProps {
  result: RecommendResult | null;
  isOpen: boolean;
  onClose: () => void;
  gpusPerNode: number | null;
  costingsEnabled: boolean;
  models: FrontierModel[];
  source: PricingSource;
  stale: boolean;
  updatedAt: string | null;
  loading: boolean;
  error: string | null;
}

type Field = 'gpusPerNode' | 'nodes' | 'costPerNodeMonth' | 'otherCostMonth' |
  'users' | 'activeHoursDay' | 'dutyCyclePct' | 'workDaysMonth' | 'cacheHitPct';
type Values = Record<Field, string>;

const defaults: Values = {
  gpusPerNode: '8', nodes: '1', costPerNodeMonth: '', otherCostMonth: '0',
  users: '200', activeHoursDay: '8', dutyCyclePct: '30', workDaysMonth: '22', cacheHitPct: '0',
};

const fieldSpecs: Array<{ key: Field; label: string; min: number; max?: number; integer?: boolean; optional?: boolean }> = [
  { key: 'gpusPerNode', label: 'GPUs per node', min: 1, integer: true },
  { key: 'nodes', label: 'Node count', min: 1, integer: true },
  { key: 'costPerNodeMonth', label: 'USD cost per node / month', min: 0, optional: true },
  { key: 'otherCostMonth', label: 'Other USD cost / month', min: 0 },
  { key: 'users', label: 'Users', min: 1, integer: true },
  { key: 'activeHoursDay', label: 'Active hours / day', min: 0, max: 24 },
  { key: 'dutyCyclePct', label: 'Duty cycle (%)', min: 0, max: 100 },
  { key: 'workDaysMonth', label: 'Working days / month', min: 1, max: 31, integer: true },
  { key: 'cacheHitPct', label: 'Cached input tokens (%)', min: 0, max: 100 },
];

function validNumber(raw: string, key: Field): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  const spec = fieldSpecs.find(f => f.key === key)!;
  if (!Number.isFinite(n) || (spec.integer && !Number.isSafeInteger(n)) ||
    (key === 'activeHoursDay' || key === 'dutyCyclePct' ? n <= 0 : n < spec.min) ||
    (spec.max != null && n > spec.max)) return null;
  return n;
}

function usd(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  if (digits === 2 && value > 0 && value < 0.01) return `$${value.toPrecision(3)}`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits }).format(value);
}

function tokens(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  if (value < 1e6) return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens`;
  return `${(value / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M tokens`;
}

function rate(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'Unavailable';
}

const colors = ['#0066cc', '#009596', '#5752d1', '#ec7a08'];

export function CostAnalysisModal({ result, isOpen, onClose, gpusPerNode, costingsEnabled,
  models, source, stale, updatedAt, loading, error }: CostAnalysisModalProps) {
  const initialGpuCount = Number.isSafeInteger(gpusPerNode) && gpusPerNode! > 0 ? gpusPerNode! : 8;
  const [values, setValues] = React.useState<Values>(() => ({ ...defaults, gpusPerNode: String(initialGpuCount),
    nodes: String(Math.max(1, Math.ceil((result?.recommendation.gpusNeeded ?? 1) / initialGpuCount))) }));
  const [gpuEdited, setGpuEdited] = React.useState(false);
  const manualNodes = React.useRef(false);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState('');
  const previousSystem = React.useRef(result?.metadata.system ?? null);

  // Catalog can arrive after sizing. Preserve edits; never use the current selector's system.
  React.useEffect(() => {
    const gpu = gpuEdited ? validNumber(values.gpusPerNode, 'gpusPerNode') :
      Number.isSafeInteger(gpusPerNode) && gpusPerNode! > 0 ? gpusPerNode! : 8;
    if (gpu === null) return;
    setValues(prev => {
      const required = Math.max(1, Math.ceil((result?.recommendation.gpusNeeded ?? 1) / gpu));
      const previous = validNumber(prev.nodes, 'nodes');
      return { ...prev, gpusPerNode: String(gpu),
        nodes: String(manualNodes.current && previous != null ? Math.max(previous, required) : required) };
    });
    // The GPU edit handler already recalculates nodes; this effect handles later catalog/sizing updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpusPerNode, result?.requestId, result?.recommendation.gpusNeeded, gpuEdited]);

  // A manually edited node layout belongs to its GPU system, not to a later
  // recommendation using different hardware. Keep demand and cost assumptions.
  React.useEffect(() => {
    const system = result?.metadata.system;
    if (!system || system === previousSystem.current) return;
    previousSystem.current = system;
    manualNodes.current = false;
    setGpuEdited(false);
    const catalogGpuCount = Number.isSafeInteger(gpusPerNode) && gpusPerNode! > 0 ? gpusPerNode! : 8;
    setValues(prev => ({ ...prev, gpusPerNode: String(catalogGpuCount),
      nodes: String(Math.max(1, Math.ceil(result.recommendation.gpusNeeded / catalogGpuCount))) }));
  }, [result?.metadata.system, result?.recommendation.gpusNeeded, gpusPerNode]);

  const gpu = validNumber(values.gpusPerNode, 'gpusPerNode');
  const required = gpu != null && result && Number.isSafeInteger(result.recommendation.gpusNeeded) && result.recommendation.gpusNeeded > 0
    ? Math.ceil(result.recommendation.gpusNeeded / gpu) : null;
  const errors: Partial<Record<Field, string>> = {};
  for (const spec of fieldSpecs) {
    const n = validNumber(values[spec.key], spec.key);
    if (n === null && !(spec.optional && values[spec.key].trim() === '')) {
      errors[spec.key] = spec.key === 'cacheHitPct' || spec.key === 'otherCostMonth' || spec.key === 'costPerNodeMonth'
        ? `Enter a finite number between ${spec.min} and ${spec.max ?? 'a nonnegative amount'}.`
        : `Enter a ${spec.integer ? 'whole ' : ''}number greater than ${spec.min === 0 ? '0' : 'or equal to ' + spec.min}${spec.max ? ` and at most ${spec.max}` : ''}.`;
    }
  }
  if (required !== null && validNumber(values.nodes, 'nodes') !== null && Number(values.nodes) < required) {
    errors.nodes = `At least ${required} nodes are required for this sizing result.`;
  }
  const costEntered = values.costPerNodeMonth.trim() !== '';
  const inputValid = Object.keys(errors).length === 0;

  function change(key: Field, raw: string) {
    if (key === 'nodes') manualNodes.current = true;
    if (key === 'gpusPerNode') {
      setGpuEdited(true);
      const nextGpu = validNumber(raw, key);
      const minNodes = nextGpu != null && result ? Math.max(1, Math.ceil(result.recommendation.gpusNeeded / nextGpu)) : null;
      setValues(prev => ({ ...prev, gpusPerNode: raw,
        nodes: minNodes == null ? prev.nodes : String(manualNodes.current && validNumber(prev.nodes, 'nodes') != null
          ? Math.max(Number(prev.nodes), minNodes) : minNodes) }));
    } else setValues(prev => ({ ...prev, [key]: raw }));
  }

  const scenarioInput: CostScenarioInput | null = result && inputValid ? {
    gpusNeeded: result.recommendation.gpusNeeded,
    gpusPerNode: Number(values.gpusPerNode), nodes: Number(values.nodes),
    costPerNodeMonth: costEntered ? Number(values.costPerNodeMonth) : 0,
    otherCostMonth: Number(values.otherCostMonth),
    isl: result.metadata.inputTokens, osl: result.metadata.outputTokens,
    users: Number(values.users), activeHoursDay: Number(values.activeHoursDay),
    dutyCyclePct: Number(values.dutyCyclePct), workDaysMonth: Number(values.workDaysMonth),
    cacheHitPct: Number(values.cacheHitPct),
    inputTokensPerSecond: result.throughput.inputTokensPerSecond,
    outputTokensPerSecond: result.throughput.outputTokensPerSecond,
    outputTokensPerSecondPerUser: result.throughput.tokensPerSecondPerUser,
    supportedConcurrency: result.performance.concurrency,
  } : null;
  const scenario = scenarioInput ? computeCostScenario(scenarioInput) : null;

  const validModels = costingsEnabled && !loading && !error ? models.filter(m =>
    m.id && Number.isFinite(m.price_per_m_input) && m.price_per_m_input >= 0 &&
    Number.isFinite(m.price_per_m_output) && m.price_per_m_output >= 0 &&
    (m.price_per_m_cached_input == null || (Number.isFinite(m.price_per_m_cached_input) && m.price_per_m_cached_input >= 0)) &&
    (m.context_window == null || (result != null && m.context_window >= result.metadata.inputTokens + result.metadata.outputTokens))) : [];
  const matches = query.trim().length > 0 ? validModels.filter(m =>
    `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30) : [];
  const selected = selectedIds.map(id => validModels.find(m => m.id === id)).filter((m): m is FrontierModel => m != null);
  const comparisons: ApiComparison[] = [];
  if (scenario && scenario.inputFraction !== null && scenario.outputFraction !== null) {
    for (const m of selected) {
      try { comparisons.push(...compareApiModels(scenario, Number(values.cacheHitPct), [m]).map(c =>
        costEntered ? c : { ...c, breakevenPct: null })); }
      catch { /* A price overflow makes just this row unavailable, not every model. */ }
    }
  }
  const canChart = isOpen && costEntered && !scenario?.error && scenario?.costPerMillionAtCapacity != null &&
    scenario.costPerMillionAtCapacity > 0 &&
    Number.isFinite(scenario.costPerMillionAtCapacity * 100);
  const curve = canChart ? costCurve(scenario!.costPerMillionAtCapacity!) : [];
  const demandMarker = scenario?.utilizationPct != null && scenario.utilizationPct > 0 && scenario.utilizationPct <= 100
    ? scenario.utilizationPct : null;

  return (
    <Modal title="Self-hosted cost analysis" variant="large" isOpen={isOpen} onClose={onClose}
      actions={[<Button key="close" variant="primary" onClick={onClose}>Close</Button>]}>
      {result && <div className={styles.content}>
        <p className={styles.description}>Scenario for {result.metadata.modelPath} on {result.metadata.system}: {result.recommendation.gpusNeeded} GPUs, {result.metadata.inputTokens} input / {result.metadata.outputTokens} output tokens, {result.performance.concurrency} supported concurrent users. Throughput comes from this sizing result, not the current form.</p>
        <h3 className={styles.heading}>Sizing estimates used for cost calculations</h3>
        <dl className={styles.sizingStats}>
          <div><dt>Recommended GPUs</dt><dd>{result.recommendation.gpusNeeded} GPUs ({result.recommendation.replicasNeeded} replicas)</dd></div>
          <div><dt>Achievable request rate</dt><dd>{rate(result.throughput.requestsPerSecond)} requests/s</dd></div>
          <div><dt>Input goodput</dt><dd>{rate(result.throughput.inputTokensPerSecond)} input tokens/s</dd></div>
          <div><dt>Output goodput</dt><dd>{rate(result.throughput.outputTokensPerSecond)} output tokens/s</dd></div>
          <div><dt>Combined goodput</dt><dd>{rate(result.throughput.totalTokensPerSecond)} total tokens/s</dd></div>
          <div><dt>Output per concurrent user</dt><dd>{rate(result.throughput.tokensPerSecondPerUser)} output tokens/s/user</dd></div>
        </dl>
        <h3 className={styles.heading}>Deployment and demand assumptions</h3>
        <div className={styles.fields}>
          {fieldSpecs.map(spec => <div key={spec.key} className={styles.field}>
            <label htmlFor={`cost-${spec.key}`} className={styles.label}>{spec.label}</label>
            <TextInput id={`cost-${spec.key}`} type="number" min={spec.min} max={spec.max}
              step={spec.integer ? 1 : 'any'} value={values[spec.key]}
              onChange={(_, value) => change(spec.key, value)} validated={errors[spec.key] ? 'error' : 'default'}
              aria-invalid={!!errors[spec.key]} aria-describedby={errors[spec.key] ? `cost-${spec.key}-error` : undefined}
              placeholder={spec.optional ? 'Enter your node cost' : undefined} />
            {errors[spec.key] && <span id={`cost-${spec.key}-error`} className={styles.error} role="alert">{errors[spec.key]}</span>}
          </div>)}
        </div>
        <p className={styles.description}>Minimum {required ?? '—'} node(s) for the recommended GPUs. Extra nodes add cost but do not increase throughput beyond this sizing result. Demand uses output tokens per second per user as an estimate of turn time; time to first token and idle time between turns are not modeled. Cache hit defaults to 0% (no cached input discount). Node pricing is your assumption; verify it if you size a different GPU system.</p>
        {scenario?.error && <p className={styles.warning} role="alert">{scenario.error}. Metrics that require this rate are unavailable.</p>}
        {scenario && <>
          <h3 className={styles.heading}>Self-hosted scenario</h3>
          <div className={styles.metrics}>
            <div><span>Monthly infrastructure cost</span><strong>{costEntered ? usd(scenario.monthlyCost, 0) : 'Enter node cost'}</strong></div>
            <div><span>Monthly demand</span><strong>{tokens(scenario.monthlyDemand)}</strong></div>
            <div><span>Monthly full capacity (30.44 days)</span><strong>{tokens(scenario.monthlyCapacity)}</strong></div>
            <div><span>Monthly utilization</span><strong>{scenario.utilizationPct == null ? 'Unavailable' : `${scenario.utilizationPct.toFixed(1)}%`}</strong></div>
            <div><span>Self-hosted USD / 1M at demand</span><strong>{costEntered ? usd(scenario.costPerMillionAtDemand) : 'Enter node cost'}</strong></div>
            <div><span>Self-hosted USD / 1M at full capacity</span><strong>{costEntered ? usd(scenario.costPerMillionAtCapacity) : 'Enter node cost'}</strong></div>
          </div>
          {scenario.overCapacity && <p className={styles.warning} role="alert">Monthly demand exceeds the sized deployment’s capacity. Cost at demand is unavailable.</p>}
          {scenario.overConcurrency && <p className={styles.warning} role="alert">Peak concurrency ({scenario.peakConcurrent?.toFixed(1)}) exceeds {result.performance.concurrency} supported users. Cost at demand is unavailable.</p>}
          {scenario.overPeakCapacity && <p className={styles.warning} role="alert">Estimated concurrent input or output token demand exceeds its serving throughput (combined rate: {scenario.peakUtilizationPct?.toFixed(1)}% of combined capacity). Cost at demand is unavailable.</p>}
        </>}

        <h3 className={styles.heading}>Compare metered API models</h3>
        {!costingsEnabled ? <p className={styles.description}>API pricing is disabled. <a href="/settings">Enable costings in settings</a> to compare models.</p> : <>
          <p className={styles.description}>Pricing source: {source}{updatedAt ? ` · updated ${updatedAt}` : ''}{stale ? ' · stale pricing (verify before use)' : ''}. API prices use the sized request’s input/output token mix (ISL/OSL); self-hosted capacity uses achieved input and output goodput. Models with a published context limit below ISL + OSL are excluded. Missing cached-input prices use the regular input price.</p>
          {loading && <p role="status">Loading API prices…</p>}
          {error && <p className={styles.warning} role="alert">API prices unavailable: {error}</p>}
          <label className={styles.label} htmlFor="cost-model-search">Search by model name, ID, or provider (choose up to four)</label>
          <TextInput id="cost-model-search" type="search" value={query} onChange={(_, value) => setQuery(value)} placeholder="Search API models" />
          {query.trim() && <div className={styles.matches} aria-label="Matching API models">
            {matches.map(m => <Checkbox key={m.id} id={`cost-model-${m.id}`} label={`${m.name} · ${m.provider} (${m.id})`}
              isChecked={selectedIds.includes(m.id)} isDisabled={!selectedIds.includes(m.id) && selectedIds.length >= 4}
              onChange={(_, checked) => setSelectedIds(prev => checked ? [...prev, m.id] : prev.filter(id => id !== m.id))} />)}
            {matches.length === 0 && <p>No valid priced models match this search.</p>}
            {matches.length === 30 && <p>Showing the first 30 matches. Refine your search for more.</p>}
          </div>}
          {selectedIds.length > 0 && <div className={styles.selected} aria-label="Selected API models">{selectedIds.map(id =>
            <span key={id}>{validModels.find(m => m.id === id)?.name ?? `${id} (price unavailable)`}
              <Button variant="link" size="sm" aria-label={`Remove ${id}`} onClick={() => setSelectedIds(prev => prev.filter(item => item !== id))}>Remove</Button>
            </span>)}</div>}
          {!loading && !error && selectedIds.some(id => !validModels.some(m => m.id === id)) && <p className={styles.warning}>Some selected models are no longer priced in this source; comparison is unavailable until their prices return.</p>}
          {selected.length > comparisons.length && <p className={styles.warning}>Some model prices exceed the supported numeric range and cannot be compared.</p>}
          {!loading && !error && validModels.length === 0 && <p className={styles.description}>No valid API model prices are available for this source.</p>}
          {selected.length > 0 && scenario?.inputFraction == null && <p className={styles.description}>API comparison needs valid input and output throughput from the sizing result.</p>}
          {comparisons.length > 0 && <div className={styles.tableScroll}><table className={styles.table}>
            <caption>API comparison at the same input/output mix and monthly demand</caption>
            <thead><tr><th scope="col">Model / provider</th><th scope="col">Source</th><th scope="col">Input / cached / output USD per 1M</th><th scope="col">Blended USD / 1M</th><th scope="col">API cost / month</th><th scope="col">Break-even utilization</th></tr></thead>
            <tbody>{comparisons.map(c => { const m = selected.find(item => item.id === c.id)!; return <tr key={c.id}>
              <th scope="row">{c.name} · {c.provider}</th><td>{c.source ?? source}</td>
              <td>{usd(m.price_per_m_input)} / {usd(m.price_per_m_cached_input ?? m.price_per_m_input)} / {usd(m.price_per_m_output)}{c.usesCacheFallback && <span> (cache price unavailable; regular input used)</span>}</td>
               <td>{usd(c.blendedCostPerMillion)}</td><td>{usd(c.monthlyApiCost)}</td>
              <td>{!costEntered ? 'Enter node cost' : c.blendedCostPerMillion === 0 ? 'No break-even (free API)' : c.breakevenPct == null ? 'Unavailable' : c.breakevenPct > 100 ? `>${100}% (${c.breakevenPct.toFixed(1)}%; beyond capacity)` : `${c.breakevenPct.toFixed(1)}%`}</td>
            </tr>; })}</tbody>
          </table></div>}
        </>}

        {canChart && curve.length > 0 && <>
          <h3 className={styles.heading}>Cost per million vs utilization</h3>
          <p className={styles.description}>Self-hosted cost from 1–100% utilization; horizontal lines show selected API blended prices. The vertical line marks monthly demand when within capacity. Break-even is where a model line crosses the curve. The vertical axis is scaled for readability around 5–100% utilization; costs at lower utilization may exceed the chart, and exact sample values are listed below.</p>
          <div className={styles.chartScroll}><div className={styles.chart}>
            <Chart ariaTitle="Self-hosted cost by utilization" ariaDesc="Self-hosted cost per million at 1 through 100 percent utilization with API model prices and monthly demand marker; values also appear in the comparison table." height={270} width={700}
              padding={{ top: 16, bottom: 50, left: 85, right: 20 }} domain={{ x: [1, 100], y: [0, Math.max(curve[4].costPerMillion, ...comparisons.map(c => c.blendedCostPerMillion * 1.2), 0.01)] }}>
              <ChartAxis label="Utilization (%)" tickValues={[1, 25, 50, 75, 100]} style={{ tickLabels: { fontSize: 12, fill: '#3c3f42' }, axisLabel: { fontSize: 13, fill: '#3c3f42' } }} />
              <ChartAxis dependentAxis label="USD / 1M" tickCount={5} style={{ tickLabels: { fontSize: 12, fill: '#3c3f42' }, axisLabel: { fontSize: 13, fill: '#3c3f42' } }} />
              <ChartLine data={curve.map(p => ({ x: p.utilizationPct, y: p.costPerMillion }))} style={{ data: { stroke: '#151515', strokeWidth: 3 } }} />
              {comparisons.map((c, i) => <ChartLine key={c.id} data={[{ x: 1, y: c.blendedCostPerMillion }, { x: 100, y: c.blendedCostPerMillion }]}
                style={{ data: { stroke: colors[i % colors.length], strokeWidth: 2 } }} />)}
              {demandMarker !== null && <ChartLine data={[{ x: demandMarker, y: 0 }, { x: demandMarker, y: Math.max(curve[4].costPerMillion, ...comparisons.map(c => c.blendedCostPerMillion * 1.2), 0.01) }]}
                style={{ data: { stroke: '#795600', strokeWidth: 2, strokeDasharray: '5,4' } }} />}
              {comparisons.filter(c => c.breakevenPct != null && c.breakevenPct >= 1 && c.breakevenPct <= 100).map((c, i) =>
                <ChartLine key={`break-${c.id}`} data={[{ x: c.breakevenPct!, y: 0 }, { x: c.breakevenPct!, y: c.blendedCostPerMillion }]}
                  style={{ data: { stroke: colors[i % colors.length], strokeWidth: 1, strokeDasharray: '3,3' } }} />)}
            </Chart>
          </div></div>
          <p className={styles.description}>Black: self-hosted · dashed brown: {demandMarker == null ? 'demand outside chart or unavailable' : `demand ${demandMarker.toFixed(1)}%`} · {comparisons.map((c, i) => <span key={c.id}><span className={styles.swatch} style={{ backgroundColor: colors[i % colors.length] }} aria-hidden="true" />{c.name} (solid API, dashed break-even) · </span>)}</p>
          <div className={styles.tableScroll}><table className={styles.table}>
            <caption>Self-hosted cost curve samples (USD per million tokens)</caption>
            <thead><tr><th scope="col">Utilization</th>{[1, 25, 50, 75, 100].map(pct => <th key={pct} scope="col">{pct}%</th>)}</tr></thead>
            <tbody><tr><th scope="row">Self-hosted cost / 1M</th>{[1, 25, 50, 75, 100].map(pct => <td key={pct}>{usd(curve[pct - 1].costPerMillion)}</td>)}</tr></tbody>
          </table></div>
          {comparisons.length > 0 && <>
            <h3 className={styles.heading}>Break-even by model</h3>
            <div className={styles.chartScroll}><div className={styles.chart}>
              <Chart ariaTitle="Break-even utilization by API model" ariaDesc="Horizontal bars show break-even utilization from 0 to 100 percent; above-capacity and free API cases are labeled in the comparison table." height={Math.max(170, comparisons.length * 48 + 75)} width={700}
                padding={{ top: 16, bottom: 40, left: 85, right: 20 }} horizontal domain={{ x: [0.5, comparisons.length + 0.5], y: [0, 100] }}>
                 <ChartAxis tickValues={comparisons.map((_, i) => i + 1)} tickFormat={comparisons.map(c => c.name.slice(0, 12))} style={{ tickLabels: { fontSize: 12, fill: '#3c3f42' } }} />
                 <ChartAxis dependentAxis tickValues={[0, 25, 50, 75, 100]} label="Utilization (%)" style={{ tickLabels: { fontSize: 12, fill: '#3c3f42' }, axisLabel: { fontSize: 13, fill: '#3c3f42' } }} />
                <ChartBar barWidth={20} data={comparisons.filter(c => c.breakevenPct != null && c.breakevenPct > 0 && c.blendedCostPerMillion > 0)
                  .map(c => ({ x: comparisons.indexOf(c) + 1, y: Math.min(c.breakevenPct!, 100) }))} style={{ data: { fill: '#0066cc' } }} />
              </Chart>
            </div></div>
            <p className={styles.description}>Bars are capped at 100%; exact values, including &gt;100%, zero-cost hosting, and no break-even for free APIs, are listed in the table above.</p>
          </>}
        </>}
      </div>}
    </Modal>
  );
}
