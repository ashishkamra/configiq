import { AgentError } from './config'

/** Enforce limits while reading, not after allocating an unbounded body. */
export async function readJson(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  if (!body) throw new AgentError('INVALID_JSON', 'Expected a JSON body.')
  const reader = body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new AgentError('TOO_LARGE', 'The response or request exceeds its size limit.', 413)
      chunks.push(value)
    }
    const buffer = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown }
    catch { throw new AgentError('INVALID_JSON', 'Invalid JSON.') }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** HF config redirects remain on the allowlisted host and the requested repository. */
export async function publicModelConfig(model: string, signal: AbortSignal): Promise<unknown> {
  if (!/^[\w-]+\/[\w][\w.-]*$/.test(model)) throw new AgentError('MODEL_UNKNOWN', 'Use an exact public Hugging Face model identifier.')
  let url = new URL(`https://huggingface.co/${model}/resolve/main/config.json`)
  for (let hop = 0; hop < 4; hop++) {
    if (url.origin !== 'https://huggingface.co' || url.username || url.password ||
      !(url.pathname.startsWith(`/${model}/`) || url.pathname.startsWith(`/api/resolve-cache/models/${model}/`))) {
      throw new AgentError('MODEL_UNKNOWN', 'The model configuration redirected outside its permitted repository.')
    }
    const response = await fetch(url, { redirect: 'manual', cache: 'no-store', signal, headers: { Accept: 'application/json' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) break
      url = new URL(location, url)
      continue
    }
    if (!response.ok) { await response.body?.cancel(); break }
    return readJson(response.body, 32 * 1024, signal)
  }
  throw new AgentError('MODEL_UNKNOWN', 'A public model configuration could not be resolved. Gated models are not supported by this assistant.')
}

export async function fetchJson(url: string, init: RequestInit, limit = 256 * 1024): Promise<unknown> {
  let response: Response
  try { response = await fetch(url, { ...init, cache: 'no-store', redirect: 'error' }) }
  catch (error) {
    if (init.signal?.aborted) throw error
    throw new AgentError('UPSTREAM_UNAVAILABLE', 'A configured service is unreachable.', 502)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new AgentError(response.status === 422 ? 'NO_CONFIGURATION' : 'UPSTREAM_ERROR',
      response.status === 422 ? 'The service could not produce a configuration for these inputs.' : 'A configured service rejected the request.', 502)
  }
  return readJson(response.body, limit)
}
