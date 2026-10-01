import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeRun } from '../controller'
import { SessionStore } from '../store'
import { AgentError, LIMITS } from '../config'
import { type StreamEvent } from '../contracts'
import { approvedSession, messageTurn, modelSequence, receipt, scenario } from './fixtures'
import { SizingToolError } from '../provenance'

beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())
function tools() {
  return { search: vi.fn().mockResolvedValue({ models: [scenario.model_path], systems: scenario.systems }),
    resolve: vi.fn().mockResolvedValue({ model_path: scenario.model_path }),
    validateScenario: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(async (_name: string, args: unknown) => receipt((args as { system: string }).system)) }
}
describe('bounded agent controller', () => {
  it('ends a proposed scenario at confirmation without sizing', async () => {
    const store = new SessionStore(), session = store.create(), turn = messageTurn()
    const { run } = store.begin(session, turn), service = tools()
    const events: StreamEvent[] = []
    await executeRun(session, run, turn, { model: modelSequence({ name: 'propose_scenario', args: { scenario, assumptions: ['Assumed SLA'] } }), tools: () => service }, e => events.push(e))
    expect(run.status).toBe('awaiting_confirmation')
    expect(session.approved).toBe(false)
    expect(session.proposal?.assumptions).toEqual(['Assumed SLA'])
    expect(service.execute).not.toHaveBeenCalled()
    expect(events.at(-1)?.type).toBe('run.finished')
  })
  it('denies sizing before approval, even when the model insists', async () => {
    const store = new SessionStore(), session = store.create(), turn = messageTurn()
    const { run } = store.begin(session, turn), service = tools()
    const action = { name: 'recommend_configuration', args: { system: 'l4' } }
    await executeRun(session, run, turn, { model: modelSequence(action, action), tools: () => service }, () => {})
    expect(service.execute).not.toHaveBeenCalled()
    expect(run.status).toBe('failed')
  })
  it('sizes approved candidates then renders deterministic evidence, not model prose', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    await executeRun(session, run, turn, { model: modelSequence(
      { name: 'recommend_configuration', args: { system: 'l4' } },
      { name: 'recommend_configuration', args: { system: 'h100' } },
      { name: 'finish', args: { resultIds: [] } }), tools: () => service }, () => {})
    expect(service.execute).toHaveBeenCalledTimes(2)
    expect(run.status).toBe('completed')
    expect(run.message).toContain('candidates: h100')
    expect(session.receipts).toHaveLength(2)
  })
  it('observes failure and tries another approved candidate', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    service.execute.mockRejectedValueOnce(new AgentError('NO_CONFIGURATION', 'No feasible configuration.'))
    await executeRun(session, run, turn, { model: modelSequence(
      { name: 'recommend_configuration', args: { system: 'l4' } },
      { name: 'recommend_configuration', args: { system: 'h100' } },
      { name: 'finish', args: { resultIds: [] } }), tools: () => service }, () => {})
    expect(run.status).toBe('partial')
    expect(session.receipts.map(r => r.status)).toEqual(['error', 'success'])
  })
  it('does not re-execute duplicate expensive calls and stops at the decision budget', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    await executeRun(session, run, turn, { model: async () => ({ id: 'call', name: 'recommend_configuration', arguments: '{"system":"l4"}', tokens: 10 }), tools: () => service }, () => {})
    expect(service.execute).toHaveBeenCalledTimes(1)
    expect(run.message).toContain('budget')
  })
  it('rejects foreign receipt references', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    const foreign = receipt()
    const action = { name: 'finish', args: { resultIds: [foreign.id] } }
    await executeRun(session, run, turn, { model: modelSequence(action, action), tools: () => service }, () => {})
    expect(run.status).toBe('failed')
    expect(run.message).not.toContain('candidates:')
  })
  it('charges formatting repairs against the model budget', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    const model = vi.fn().mockRejectedValue(new AgentError('MODEL_FORMAT', 'bad format'))
    await executeRun(session, run, turn, { model, tools: () => service }, () => {})
    expect(model).toHaveBeenCalledTimes(2)
    expect(service.execute).not.toHaveBeenCalled()
  })
  it('cancels before any model/tool call', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    run.abort.abort()
    const model = vi.fn()
    await executeRun(session, run, turn, { model, tools: () => service }, () => {})
    expect(run.status).toBe('cancelled')
    expect(model).not.toHaveBeenCalled()
  })
  it('discards a late tool result after cancellation', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    service.execute.mockImplementationOnce(async () => { run.abort.abort(); return receipt() })
    await executeRun(session, run, turn, { model: modelSequence({ name: 'recommend_configuration', args: { system: 'l4' } }), tools: () => service }, () => {})
    expect(run.status).toBe('cancelled')
    expect(session.receipts).toHaveLength(0)
  })
  it('bounds expensive calls even when the model requests different configurations', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    let batch = 1
    const model = vi.fn(async () => ({ id: 'call', name: 'estimate_configuration', arguments: JSON.stringify({ system: 'l4', tp_size: 1, pp_size: 1, batch_size: batch++ }), tokens: 20 }))
    await executeRun(session, run, turn, { model, tools: () => service }, () => {})
    expect(service.execute).toHaveBeenCalledTimes(LIMITS.expensiveCalls)
    expect(run.message).toContain('budget')
  })
  it('preserves classified failed-attempt provenance instead of rebuilding a generic receipt', async () => {
    const { session, turn, run } = approvedSession(), service = tools()
    const failed = receipt()
    failed.tool = 'estimate_configuration'
    failed.inputs = { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 }
    failed.inputHash = 'exact-wire-hash'
    failed.provenance = { contractVersion: '2', promptVersion: '2', endpoint: 'estimate', payloadCaptured: true,
      inputHashSource: 'wire_payload', requestIdSource: 'none', modelConfigHash: null, servingModelId: 'Qwen/model', servingModelRevision: null }
    service.execute.mockRejectedValueOnce(new SizingToolError(failed, new AgentError('INVALID_EVIDENCE', 'Invalid estimate evidence.', 502)))
    await executeRun(session, run, turn, { model: modelSequence(
      { name: 'estimate_configuration', args: { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 } },
      { name: 'finish', args: { resultIds: [failed.id] } }), tools: () => service }, () => {})
    expect(session.receipts).toEqual([failed])
    expect(session.receipts[0].status).toBe('error')
    expect(session.receipts[0].metrics).toEqual({})
    expect(run.status).toBe('partial')
    expect(run.message).toContain('No verified recommendation')
  })
})
