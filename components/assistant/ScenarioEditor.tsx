'use client'

import * as React from 'react'
import { Button, Form, FormGroup, FormSelect, FormSelectOption, TextInput, Alert } from '@patternfly/react-core'
import { ScenarioSchema, type Scenario } from '@/lib/agent/contracts'
import styles from './Assistant.module.css'

export function ScenarioEditor({ scenario, disabled, onSave, onDirtyChange }: { scenario: Scenario; disabled: boolean; onSave: (scenario: Scenario) => void; onDirtyChange?: () => void }) {
  const [fields, setFields] = React.useState(() => ({
    model_path: scenario.model_path, systems: scenario.systems.join(', '), backend: scenario.backend,
    backend_version: scenario.backend_version ?? '', isl: String(scenario.isl), osl: String(scenario.osl),
    ttft: String(scenario.ttft), tpot: String(scenario.tpot), prefix: String(scenario.prefix),
    request_latency: scenario.request_latency === null ? '' : String(scenario.request_latency),
    loadMode: scenario.target_concurrency === null ? 'rate' : 'concurrency',
    load: String(scenario.target_concurrency ?? scenario.target_request_rate), objective: scenario.objective,
  }))
  const [error, setError] = React.useState('')
  const input = (key: keyof typeof fields, label: string, numeric = false) => <FormGroup key={key} label={label} fieldId={`agent-${key}`}>
    <TextInput id={`agent-${key}`} aria-label={label} value={fields[key]} type={numeric ? 'number' : 'text'} isDisabled={disabled}
      onChange={(_event, value) => { onDirtyChange?.(); setFields(previous => ({ ...previous, [key]: value })) }} />
  </FormGroup>
  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!fields.prefix.trim()) { setError('Enter cached prefix tokens explicitly; use 0 for no cached prefix.'); return }
    const parsed = ScenarioSchema.safeParse({ model_path: fields.model_path.trim(), systems: fields.systems.split(',').map(s => s.trim()),
      backend: fields.backend, backend_version: fields.backend_version || null,
      isl: Number(fields.isl), osl: Number(fields.osl), ttft: Number(fields.ttft), tpot: Number(fields.tpot), prefix: Number(fields.prefix),
      request_latency: fields.request_latency === '' ? null : Number(fields.request_latency),
      target_concurrency: fields.loadMode === 'concurrency' ? Number(fields.load) : null,
      target_request_rate: fields.loadMode === 'rate' ? Number(fields.load) : null, objective: fields.objective })
    if (!parsed.success) { setError('Check the fields: positive token/load/latency values, unique systems, and prefix no longer than input.'); return }
    setError(''); onSave(parsed.data)
  }
  return <Form onSubmit={submit} className={styles.editor}>
    {input('model_path', 'Model identifier')}
    {input('systems', 'GPU system IDs (up to three, comma separated)')}
    <FormGroup label="Backend" fieldId="agent-backend">
      <FormSelect id="agent-backend" value={fields.backend} isDisabled={disabled} onChange={(_e, backend) => { onDirtyChange?.(); setFields(p => ({ ...p, backend: backend as Scenario['backend'] })) }}>
        {['vllm', 'sglang', 'tensorrt-llm'].map(value => <FormSelectOption key={value} value={value} label={value} />)}
      </FormSelect>
    </FormGroup>
    {input('backend_version', 'Backend version (optional)')}
    <div className={styles.fields}>
      {input('isl', 'Input tokens', true)}{input('osl', 'Output tokens', true)}
      {input('ttft', 'First-token latency target (ms)', true)}{input('tpot', 'Time per output token target (ms)', true)}
      {input('prefix', 'Cached prefix tokens', true)}{input('request_latency', 'Request latency target (ms, optional)', true)}
    </div>
    <FormGroup label="Load target" fieldId="agent-load-mode">
      <FormSelect id="agent-load-mode" value={fields.loadMode} isDisabled={disabled} onChange={(_e, loadMode) => { onDirtyChange?.(); setFields(p => ({ ...p, loadMode })) }}>
        <FormSelectOption value="concurrency" label="Concurrent in-flight requests" /><FormSelectOption value="rate" label="Requests per second" />
      </FormSelect>
    </FormGroup>
    {input('load', fields.loadMode === 'rate' ? 'Requests per second' : 'Concurrent requests', true)}
    <FormGroup label="Comparison objective" fieldId="agent-objective">
      <FormSelect id="agent-objective" value={fields.objective} isDisabled={disabled} onChange={(_e, objective) => { onDirtyChange?.(); setFields(p => ({ ...p, objective: objective as Scenario['objective'] })) }}>
        <FormSelectOption value="satisfy_constraints" label="Compare without selecting a winner" />
        <FormSelectOption value="minimize_gpu_count" label="Fewest GPUs meeting constraints (not lowest cost)" />
        <FormSelectOption value="minimize_ttft" label="Lowest first-token latency meeting constraints" />
      </FormSelect>
    </FormGroup>
    {error && <Alert variant="danger" isInline title={error} />}
    <Button type="submit" variant="secondary" isDisabled={disabled}>Save edits for review</Button>
  </Form>
}
