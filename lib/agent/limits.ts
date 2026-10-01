import { AgentError, LIMITS } from './config'

/** FIFO, abortable admission. Queue and in-flight counts are process-wide. */
export class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly capacity: number, private readonly queued = 8) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active < this.capacity) { this.active++; return this.releaseOnce() }
    if (this.queue.length >= this.queued) throw new AgentError('BUSY', 'The assistant is busy. Please try again shortly.', 429)
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.queue = this.queue.filter(item => item !== ready)
        reject(signal.reason)
      }
      const ready = () => { signal.removeEventListener('abort', abort); resolve(this.releaseOnce()) }
      signal.addEventListener('abort', abort, { once: true })
      this.queue.push(ready)
    })
  }
  private releaseOnce() {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next()
      else this.active--
    }
  }
  async use<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal)
    try { signal.throwIfAborted(); return await action() } finally { release() }
  }
}

export class RateLimit {
  private buckets = new Map<string, { count: number; until: number }>()
  take(key: string, maximum: number, now = Date.now()) {
    for (const [id, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(id)
    const bucket = this.buckets.get(key) ?? { count: 0, until: now + 60_000 }
    if (bucket.count >= maximum || (!this.buckets.has(key) && this.buckets.size >= 2000)) {
      throw new AgentError('RATE_LIMITED', 'Too many requests. Please wait a minute.', 429)
    }
    bucket.count++; this.buckets.set(key, bucket)
  }
}

const runtime = globalThis as typeof globalThis & { configiqAgentLimitsV1?: ReturnType<typeof createLimits> }
function createLimits() {
  return { runs: new Semaphore(LIMITS.activeRuns, LIMITS.queuedRuns), model: new Semaphore(process.env.CONFIGIQ_AGENT_MODEL_CONCURRENCY === '2' ? LIMITS.modelConcurrency : 1),
    sizing: new Semaphore(LIMITS.sizingConcurrency), rate: new RateLimit() }
}
export const limits = runtime.configiqAgentLimitsV1 ??= createLimits()
