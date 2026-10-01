import { HandoffSchema, HANDOFF_KEY, StreamEventSchema, type Scenario, type StreamEvent } from './contracts'

export async function consumeAgentStream(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.body) throw new Error('The assistant response has no stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', sequence = 0, runId = '', finished = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 512 * 1024) throw new Error('The assistant event exceeded its size limit.')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
        if (!data) continue
        const event = StreamEventSchema.parse(JSON.parse(data))
        if (runId && runId !== event.runId) throw new Error('The assistant stream changed runs unexpectedly.')
        runId = event.runId
        if (event.sequence <= sequence) continue
        sequence = event.sequence
        onEvent(event)
        if (event.type === 'run.finished') finished = true
      }
    }
    if (!finished) throw new Error('The assistant connection ended early. Refresh status before retrying.')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function saveSizingDraft(storage: Pick<Storage, 'setItem'>, scenario: Scenario, system: string) {
  storage.setItem(HANDOFF_KEY, JSON.stringify(HandoffSchema.parse({ scenario, system, createdAt: Date.now() })))
}
export function takeSizingDraft(storage: Pick<Storage, 'getItem' | 'removeItem'>, now = Date.now()) {
  const raw = storage.getItem(HANDOFF_KEY)
  storage.removeItem(HANDOFF_KEY)
  if (!raw || raw.length > 16_384) return null
  try {
    const draft = HandoffSchema.parse(JSON.parse(raw))
    return now >= draft.createdAt && now - draft.createdAt < 30 * 60_000 ? draft : null
  } catch { return null }
}
