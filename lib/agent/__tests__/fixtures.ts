import { randomUUID } from 'node:crypto'
import type { Receipt, Scenario, Turn } from '../contracts'
import type { ModelTransport } from '../model-client'
import { SessionStore, propose } from '../store'

export const scenario: Scenario = {
  model_path: 'Qwen/Qwen3-8B', systems: ['l4', 'h100'], backend: 'vllm', backend_version: null,
  isl: 2048, osl: 128, ttft: 1000, tpot: 30, target_concurrency: 8, target_request_rate: null,
  request_latency: null, prefix: 0, objective: 'minimize_gpu_count',
}
export const messageTurn = (revision = 0, text = 'Size my workload'): Turn => ({ clientTurnId: randomUUID(), revision, event: { type: 'message', text } })
export function approvedSession() {
  const store = new SessionStore()
  const session = store.create()
  const proposal = propose(session, { ...scenario }, [], 'user_edit')
  const turn: Turn = { clientTurnId: randomUUID(), revision: session.revision, event: { type: 'approve', proposalId: proposal.id } }
  const { run } = store.begin(session, turn)
  return { store, session, turn, run }
}
export function receipt(system = 'l4', revision = 1): Receipt {
  return { id: randomUUID(), revision, inputHash: 'hash', tool: 'recommend_configuration', system,
    timestamp: new Date().toISOString(), requestId: 'backend-id', status: 'success', error: null,
    metrics: { gpus: { value: system === 'l4' ? 2 : 1, label: 'Total GPUs', unit: 'GPUs' },
      ttft: { value: 200, label: 'Time to first token', unit: 'ms' },
      tpot: { value: 20, label: 'Time per output token', unit: 'ms' },
      concurrency: { value: 8, label: 'Concurrency', unit: 'requests' } }, warnings: [], meetsConstraints: 'yes', inputs: {} }
}
export function modelSequence(...actions: Array<{ name: string; args: unknown }>): ModelTransport {
  let index = 0
  return async () => {
    const action = actions[index++]
    if (!action) throw new Error('Unexpected extra model invocation')
    return { id: `call-${index}`, name: action.name, arguments: JSON.stringify(action.args), tokens: 30 }
  }
}
