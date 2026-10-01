// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assistant } from './Assistant'
import { ScenarioEditor } from './ScenarioEditor'
import { scenario } from '@/lib/agent/__tests__/fixtures'
import type { Snapshot } from '@/lib/agent/contracts'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
function state(): Snapshot {
  return { revision: 1, scenario, approved: false, receipts: [], messages: [], run: null,
    proposal: { id: '9094dfd2-422c-40f6-a7bf-9815d4148bb0', revision: 1, scenario, assumptions: ['Assumed input length'], expiresAt: Date.now() + 100_000, source: 'agent_proposal' } }
}
async function fill(id: string, value: string) {
  await act(async () => {
    const input = document.getElementById(id) as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
describe('assistant experience', () => {
  it('shows a useful unavailable state and keeps the standard form reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Not enabled' } }, { status: 503 })))
    await act(async () => root.render(<Assistant />))
    expect(container.textContent).toContain('Not enabled')
    expect(container.querySelector('a[href="/recommend"]')).not.toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('#agent-message')?.disabled).toBe(true)
  })
  it('shows assumptions and blocks approval while edited fields are unsaved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(state())))
    await act(async () => root.render(<Assistant />))
    const approve = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Approve and run sizing')!
    expect(approve.disabled).toBe(false)
    expect(container.textContent).toContain('Assumed input length')
    await fill('agent-isl', '8192')
    expect(approve.disabled).toBe(true)
    expect(container.textContent).toContain('Save your edits before approving')
  })
  it('keeps scenario editing separate from approval and validates load', async () => {
    const onSave = vi.fn()
    await act(async () => root.render(<ScenarioEditor scenario={scenario} disabled={false} onSave={onSave} />))
    await fill('agent-load', '0')
    await act(async () => container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(onSave).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Check the fields')
    await fill('agent-load', '16')
    await act(async () => container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(onSave).toHaveBeenCalledWith({ ...scenario, target_concurrency: 16 })
  })
  it('renders service metrics as text and does not execute markup in messages', async () => {
    const data = state()
    data.messages = [{ role: 'assistant', text: '<script>window.evil=true</script>' }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)))
    await act(async () => root.render(<Assistant />))
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>')
  })
})
