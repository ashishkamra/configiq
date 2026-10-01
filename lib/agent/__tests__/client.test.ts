import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { consumeAgentStream, saveSizingDraft, takeSizingDraft } from '../client'
import { HANDOFF_KEY, type StreamEvent } from '../contracts'
import { SessionStore, snapshot } from '../store'
import { scenario } from './fixtures'

function storage() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } }
}
describe('browser protocol and handoff', () => {
  it('handles fragmented UTF-8 events and ignores heartbeat/comment frames', async () => {
    const event: StreamEvent = { runId: randomUUID(), sequence: 1, type: 'run.finished', snapshot: snapshot(new SessionStore().create()) }
    event.snapshot.messages.push({ role: 'assistant', text: 'Résumé ✓' })
    const encoded = new TextEncoder().encode(`: heartbeat\n\ndata: ${JSON.stringify(event)}\n\n`)
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let i = 0; i < encoded.length; i += 3) controller.enqueue(encoded.slice(i, i + 3))
      controller.close()
    } })
    const events: StreamEvent[] = []
    await consumeAgentStream(new Response(stream), e => events.push(e))
    expect(events).toEqual([event])
  })
  it('does not treat a disconnected stream as a completed run', async () => {
    await expect(consumeAgentStream(new Response(': heartbeat\n\n'), () => {})).rejects.toThrow(/ended early/)
  })
  it('transfers a validated draft once, including request rate and backend version', () => {
    const cache = storage(), value = { ...scenario, target_concurrency: null, target_request_rate: 0.5, backend_version: 'test-version' }
    saveSizingDraft(cache, value, 'l4')
    expect(takeSizingDraft(cache)?.scenario).toEqual(value)
    expect(takeSizingDraft(cache)).toBeNull()
  })
  it('rejects expired, future, malformed, and foreign-system drafts', () => {
    const cache = storage()
    for (const raw of ['{', JSON.stringify({ scenario, system: 'foreign', createdAt: Date.now() }),
      JSON.stringify({ scenario, system: 'l4', createdAt: 1 }), JSON.stringify({ scenario, system: 'l4', createdAt: Date.now() + 60_000 })]) {
      cache.setItem(HANDOFF_KEY, raw)
      expect(takeSizingDraft(cache)).toBeNull()
      expect(cache.getItem(HANDOFF_KEY)).toBeNull()
    }
  })
})
