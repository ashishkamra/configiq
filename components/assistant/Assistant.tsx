'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Alert, Button, Card, CardBody, CardTitle, Label, Spinner, TextArea } from '@patternfly/react-core'
import { SnapshotSchema, isActive, type Snapshot, type Turn } from '@/lib/agent/contracts'
import { consumeAgentStream, saveSizingDraft } from '@/lib/agent/client'
import { ScenarioEditor } from './ScenarioEditor'
import styles from './Assistant.module.css'

async function errorMessage(response: Response) {
  const data: unknown = await response.json().catch(() => null)
  if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' && 'message' in data.error && typeof data.error.message === 'string') return data.error.message
  return 'The assistant request failed. Try again or use Recommend sizing.'
}
export function Assistant() {
  const router = useRouter()
  const [state, setState] = React.useState<Snapshot | null>(null)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [ready, setReady] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const active = React.useRef<AbortController | null>(null)
  const runId = React.useRef<string | null>(null)
  const input = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => { setDirty(false) }, [state?.revision])
  React.useEffect(() => { if (!busy && ready) input.current?.focus() }, [busy, ready])

  React.useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/agent/session', { method: 'POST', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(await errorMessage(response))
      const next = SnapshotSchema.parse(await response.json())
      if (!controller.signal.aborted) { setState(next); setReady(true) }
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Assistant unavailable.') })
    return () => { controller.abort(); active.current?.abort() }
  }, [])

  async function refresh() {
    try {
      const response = await fetch('/api/agent/session')
      if (!response.ok) throw new Error(await errorMessage(response))
      setState(SnapshotSchema.parse(await response.json()))
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not refresh the conversation.') }
  }
  async function send(event: Turn['event']) {
    if (!state || active.current || (state.run && isActive(state.run.status))) return
    const controller = new AbortController()
    active.current = controller; runId.current = null
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/agent/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientTurnId: crypto.randomUUID(), revision: state.revision, event }), signal: controller.signal })
      if (!response.ok) throw new Error(await errorMessage(response))
      if (event.type === 'message') setText('')
      if (response.headers.get('content-type')?.includes('application/json')) {
        const data: { snapshot?: unknown } = await response.json()
        setState(SnapshotSchema.parse(data.snapshot))
      } else {
        await consumeAgentStream(response, update => {
          runId.current = update.runId
          setState(update.snapshot)
        })
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'The assistant disconnected.')
      await refresh()
    } finally { active.current = null; setBusy(false); input.current?.focus() }
  }
  async function cancel() {
    const id = runId.current ?? state?.run?.id
    if (id) await fetch(`/api/agent/runs/${id}`, { method: 'DELETE' }).catch(() => {})
    active.current?.abort()
    await refresh()
  }
  async function reset() {
    if (busy) return
    setError('')
    try {
      const deleted = await fetch('/api/agent/session', { method: 'DELETE' })
      if (!deleted.ok) throw new Error(await errorMessage(deleted))
      const response = await fetch('/api/agent/session', { method: 'POST' })
      if (!response.ok) throw new Error(await errorMessage(response))
      setState(SnapshotSchema.parse(await response.json())); setReady(true)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not reset the conversation.') }
  }
  const pending = busy || (state?.run ? isActive(state.run.status) : false)
  return <div className={styles.page}>
    <header className={styles.header}><h1>Ask ConfigIQ</h1>
      <p>Describe an inference workload. Review the agent’s assumptions, then let it evaluate configurations with AISimulators.</p>
      <p>Text only. Conversations expire after inactivity or a service restart. <Link href="/recommend">Use the standard sizing form</Link>.</p>
    </header>
    {error && <Alert variant="warning" isInline title={error} />}
    <div className={styles.actions}>
      <Button variant="secondary" onClick={() => void reset()} isDisabled={!!pending}>New conversation</Button>
      <Button variant="link" onClick={() => void refresh()} isDisabled={!ready}>Refresh status</Button>
      {pending && <Button variant="secondary" onClick={() => void cancel()}>Cancel run</Button>}
    </div>
    <div className={styles.layout}>
      <Card><CardTitle>Conversation</CardTitle><CardBody>
        <div className={styles.messages} role="log" aria-label="Sizing conversation" aria-live="polite">
          {!state?.messages.length && <p>Try “Help size a RAG chatbot” or “Compare GPU options for my model.” The assistant will ask for missing requirements.</p>}
          {state?.messages.map((message, index) => <div key={index} className={styles.message}>
            <strong>{message.role === 'user' ? 'You' : 'ConfigIQ'}</strong><p>{message.text}</p>
          </div>)}
        </div>
        <p role="status" className={styles.status}>{pending && <Spinner size="sm" aria-label="Agent working" />} {state?.run?.message ?? (ready ? 'Ready for your workload.' : 'Connecting to the assistant…')}</p>
        <form onSubmit={event => { event.preventDefault(); if (text.trim()) void send({ type: 'message', text }) }}>
          <label htmlFor="agent-message">Your workload or follow-up question</label>
          <TextArea id="agent-message" ref={input} value={text} onChange={(_event, value) => setText(value)} isDisabled={!ready || !!pending} maxLength={16_384} rows={5} />
          <Button type="submit" className={styles.send} isDisabled={!ready || !!pending || !text.trim()}>Send</Button>
        </form>
      </CardBody></Card>
      <Card><CardTitle>Scenario and approval</CardTitle><CardBody>
        {!state?.scenario && <p>No scenario yet. Describe your model, load, input/output lengths, and latency requirements.</p>}
        {state?.scenario && <>
          <Label color={state.approved ? 'green' : 'orange'}>{state.approved ? 'Approved' : 'Requires review'}</Label>
          {state.proposal && <div className={styles.approval}>
            <h2>Review the proposed scenario</h2>
            <p>Check every value below. Approval authorizes read-only sizing calls for these candidate systems.</p>
            {state.proposal.assumptions.length > 0 && <><h3>Agent-proposed assumptions</h3><ul>{state.proposal.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></>}
            {dirty && <p role="status">Save your edits before approving so the reviewed values match the scenario sent for sizing.</p>}
            <Button onClick={() => void send({ type: 'approve', proposalId: state.proposal!.id })} isDisabled={!!pending || dirty}>Approve and run sizing</Button>
          </div>}
          <ScenarioEditor key={state.revision} scenario={state.scenario} disabled={!!pending} onDirtyChange={() => setDirty(true)} onSave={scenario => void send({ type: 'edit', scenario })} />
        </>}
      </CardBody></Card>
    </div>
    {state?.receipts.length ? <section aria-label="Verified sizing evidence" className={styles.results}>
      <h2>Tool results</h2><p>These are modeled estimates. Missing values are shown as unavailable, never as measured zero.</p>
      {state.receipts.map(receipt => <Card key={receipt.id}><CardTitle>{receipt.system} · {receipt.tool.replaceAll('_', ' ')}</CardTitle><CardBody>
        <p className={styles.caption}>{receipt.timestamp} · {receipt.requestId ?? receipt.id} · scenario revision {receipt.revision}</p>
        {receipt.error && <Alert variant="warning" isInline title={receipt.error} />}
        {receipt.status === 'success' && <>
          <p>Supplied latency and load constraints: {receipt.meetsConstraints === 'yes' ? 'met' : receipt.meetsConstraints === 'no' ? 'not met' : 'not fully verified'}.</p>
          <dl className={styles.metrics}>{Object.entries(receipt.metrics).map(([key, value]) => <div key={key}><dt>{value.label}</dt><dd>{value.value === null ? 'Unavailable' : `${value.value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${value.unit}`}</dd></div>)}</dl>
          {receipt.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
          <details><summary>Evidence inputs</summary><pre>{JSON.stringify(receipt.inputs, null, 2)}</pre></details>
          {receipt.tool === 'recommend_configuration' && <Button variant="secondary" isDisabled={!!pending || !state.approved || receipt.revision !== state.revision} onClick={() => {
            try { saveSizingDraft(sessionStorage, state.scenario!, receipt.system); router.push('/recommend') }
            catch { setError('Could not transfer the draft. Browser session storage may be disabled.') }
          }}>Open in sizing</Button>}
        </>}
      </CardBody></Card>)}
    </section> : null}
  </div>
}
