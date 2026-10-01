import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { AgentError, getAgentConfig, LIMITS } from './config'
import { TurnSchema, type Snapshot } from './contracts'
import { executeRun } from './controller'
import { readJson } from './http'
import { limits } from './limits'
import { createModelTransport } from './model-client'
import { snapshot, store, type Session } from './store'

const COOKIE = 'configiq-agent-session'
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers }) }
function renew(response: NextResponse, session: Session, origin: string) {
  response.cookies.set(COOKIE, session.id, { maxAge: LIMITS.sessionTtl / 1000, path: '/api/agent',
    httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'strict' })
  return response
}
function guard(request: NextRequest) {
  const config = getAgentConfig()
  const origin = request.headers.get('origin')
  if ((request.method !== 'GET' && origin !== config.origin) || (origin && origin !== config.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AgentError('ORIGIN_DENIED', 'This request must originate from ConfigIQ.', 403)
  }
  limits.rate.take('global:requests', 300)
  // Trust no forwarded IP by default. Set only when the ingress overwrites this header.
  const trustedHeader = process.env.CONFIGIQ_AGENT_CLIENT_IP_HEADER
  const client = trustedHeader ? request.headers.get(trustedHeader) : null
  if (client) limits.rate.take(`ip:${client.slice(0, 100)}`, 60)
  return config
}
function sessionFor(request: NextRequest) { return store.get(request.cookies.get(COOKIE)?.value) }
function failure(error: unknown) {
  if (error instanceof AgentError) {
    const response = json({ error: { code: error.code, message: error.message } }, error.status)
    if (error.status === 429) response.headers.set('Retry-After', '60')
    return response
  }
  if (error instanceof z.ZodError) return json({ error: { code: 'INVALID_INPUT', message: 'The request failed validation.' } }, 400)
  return json({ error: { code: 'INTERNAL_ERROR', message: 'The assistant could not complete this request.' } }, 500)
}
export async function sessionRoute(request: NextRequest) {
  try {
    const config = guard(request)
    if (request.method === 'DELETE') {
      const id = request.cookies.get(COOKIE)?.value
      if (id) store.delete(id)
      const response = json({ deleted: true })
      response.cookies.set(COOKIE, '', { maxAge: 0, path: '/api/agent', httpOnly: true, sameSite: 'strict', secure: config.origin.startsWith('https:') })
      return response
    }
    let session: Session
    if (request.method === 'POST') {
      try { session = sessionFor(request) }
      catch {
        limits.rate.take('global:create', 20)
        session = store.create()
      }
    } else session = sessionFor(request)
    return renew(json(snapshot(session)), session, config.origin)
  } catch (error) { return failure(error) }
}

export async function runRoute(request: NextRequest) {
  try {
    const config = guard(request)
    const session = sessionFor(request)
    limits.rate.take(`session:${session.id}`, 12)
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AgentError('INVALID_INPUT', 'Use application/json.')
    const body = await readJson(request.body, LIMITS.bodyBytes, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]))
    const turn = TurnSchema.parse(body)
    if (turn.event.type === 'message' && Buffer.byteLength(turn.event.text) > 16_384) throw new AgentError('TOO_LARGE', 'Shorten the message.', 413)
    request.signal.throwIfAborted()
    const { run, duplicate } = store.begin(session, turn)
    if (duplicate) return renew(json({ duplicate: true, runId: run.id, snapshot: snapshot(session) }), session, config.origin)
    const encoder = new TextEncoder()
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const abort = () => run.abort.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          if (closed) return
          if ((controller.desiredSize ?? 0) < 0) { run.abort.abort(); return }
          controller.enqueue(encoder.encode(text))
        }
        heartbeat = setInterval(() => write(': heartbeat\n\n'), 10_000)
        void executeRun(session, run, turn, { model: createModelTransport(config) }, event => {
          write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
        }).finally(() => {
          clearInterval(heartbeat)
          request.signal.removeEventListener('abort', abort)
          if (!closed) { closed = true; controller.close() }
        })
      },
      cancel() { closed = true; clearInterval(heartbeat); request.signal.removeEventListener('abort', abort); run.abort.abort() },
    }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength })
    return renew(new NextResponse(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } }), session, config.origin)
  } catch (error) { return failure(error) }
}
export async function runDetailRoute(request: NextRequest, id: string) {
  try {
    const config = guard(request)
    const session = sessionFor(request)
    const run = session.runs.find(r => r.id === id)
    if (!run) throw new AgentError('NOT_FOUND', 'Run not found.', 404)
    if (request.method === 'DELETE') run.abort.abort()
    const view: Snapshot = snapshot(session)
    return renew(json({ ...view, run: { id: run.id, status: run.status, message: run.message, startedAt: run.startedAt } }), session, config.origin)
  } catch (error) { return failure(error) }
}
