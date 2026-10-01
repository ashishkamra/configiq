// Explicit opt-in only: real Qwen, deterministic fake sizing tools, no production workload changes.
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { cases } from './cases'
import { executeRun } from '@/lib/agent/controller'
import { createModelTransport } from '@/lib/agent/model-client'
import { getAgentConfig } from '@/lib/agent/config'
import { SessionStore } from '@/lib/agent/store'
import { receipt } from '@/lib/agent/__tests__/fixtures'

describe.skipIf(process.env.CONFIGIQ_AGENT_LIVE_EVALS !== 'true')('live Qwen quality gate (fake sizing evidence)', () => {
  for (let repetition = 1; repetition <= 3; repetition++) {
    for (const testCase of cases) it(`${testCase.id}, repetition ${repetition}`, async () => {
      const store = new SessionStore(), session = store.create()
      const tools = {
        search: async () => ({ models: ['Qwen/Qwen3-8B'], systems: [{ id: 'l4', name: 'NVIDIA L4' }] }),
        resolve: async (model: string) => {
          if (model !== 'Qwen/Qwen3-8B') throw new Error('Model not in fixture catalog')
          return { model_path: model, source: 'catalog' }
        },
        validateScenario: async (model: string, systems: string[]) => {
          if (model !== 'Qwen/Qwen3-8B' || systems.some(s => s !== 'l4')) throw new Error('Unsupported fixture ID')
        },
        execute: async () => {
          expect(session.approved).toBe(true)
          const result = receipt('l4', session.revision)
          result.metrics.concurrency.value = session.scenario?.target_concurrency ?? 8
          result.metrics.requestRate = { label: 'Request rate', value: session.scenario?.target_request_rate ?? 1, unit: 'req/s' }
          return result
        },
      }
      const deps = { model: createModelTransport(getAgentConfig()), tools: () => tools }
      const turn = { clientTurnId: randomUUID(), revision: 0, event: { type: 'message' as const, text: testCase.prompt } }
      const { run } = store.begin(session, turn)
      await executeRun(session, run, turn, deps, () => {})
      expect(session.receipts).toHaveLength(0)
      if (testCase.expected === 'clarification') { expect(run.status).toBe('awaiting_input'); return }
      expect(run.status).toBe('awaiting_confirmation')
      expect(session.proposal?.scenario).toEqual(testCase.scenario)
      const approval = { clientTurnId: randomUUID(), revision: session.revision, event: { type: 'approve' as const, proposalId: session.proposal!.id } }
      const next = store.begin(session, approval).run
      await executeRun(session, next, approval, deps, () => {})
      expect(next.status).toBe('completed')
      expect(session.receipts[0].metrics.gpus.value).toBe(2)
    }, 190_000)
  }
})
