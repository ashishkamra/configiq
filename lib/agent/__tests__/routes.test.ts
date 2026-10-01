import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { sessionRoute, runRoute, runDetailRoute } from '../routes'
import { store, snapshot } from '../store'
import { consumeAgentStream } from '../client'
import { messageTurn } from './fixtures'
import { type StreamEvent } from '../contracts'

const origin = 'https://configiq.test'
function req(path: string, method = 'GET', cookie?: string, body?: unknown, requestOrigin = origin) {
  return new NextRequest(`${origin}/api/agent/${path}`, { method,
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: `configiq-agent-session=${cookie}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
beforeEach(() => {
  vi.stubEnv('CONFIGIQ_AGENT_ENABLED', 'true')
  vi.stubEnv('CONFIGIQ_AGENT_SINGLE_PROCESS', 'true')
  vi.stubEnv('CONFIGIQ_AGENT_ORIGIN', origin)
  vi.stubEnv('CONFIGIQ_AGENT_MODEL_BASE_URL', 'http://model.test/v1')
  vi.stubEnv('CONFIGIQ_AGENT_MODEL_API_KEY', 'secret')
  vi.stubEnv('AISIMULATORS_GATEWAY_URL', 'http://gateway.test')
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('agent HTTP boundary', () => {
  it('returns 503 with the feature disabled, without contacting any service', async () => {
    vi.stubEnv('CONFIGIQ_AGENT_ENABLED', 'false')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect((await sessionRoute(req('session', 'POST'))).status).toBe(503)
    expect((await runRoute(req('runs', 'POST', undefined, messageTurn()))).status).toBe(503)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects cross-origin mutation and does not publish wildcard CORS', async () => {
    const response = await sessionRoute(req('session', 'POST', undefined, undefined, 'https://evil.test'))
    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
  it('creates a private session and returns only public state', async () => {
    const response = await sessionRoute(req('session', 'POST'))
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(response.headers.get('set-cookie')).toMatch(/Secure/i)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const data = await response.json()
    expect(data.revision).toBe(0)
    expect(data).not.toHaveProperty('id')
    expect(data).not.toHaveProperty('modelConfigs')
  })
  it('rejects missing sessions, oversized input, stale revisions, and extra fields', async () => {
    expect((await runRoute(req('runs', 'POST', undefined, messageTurn()))).status).toBe(404)
    const session = store.create()
    expect((await runRoute(req('runs', 'POST', session.id, messageTurn(10)))).status).toBe(409)
    expect((await runRoute(req('runs', 'POST', session.id, { ...messageTurn(), tools: [] }))).status).toBe(400)
    expect((await runRoute(req('runs', 'POST', session.id, messageTurn(0, 'x'.repeat(40_000))))).status).toBe(413)
    store.delete(session.id)
  })
  it('does not reveal or cancel another session run', async () => {
    const a = store.create(), b = store.create()
    const { run } = store.begin(a, messageTurn())
    expect((await runDetailRoute(req(`runs/${run.id}`, 'DELETE', b.id), run.id)).status).toBe(404)
    expect(run.abort.signal.aborted).toBe(false)
    expect((await runDetailRoute(req(`runs/${run.id}`, 'DELETE', a.id), run.id)).status).toBe(200)
    expect(run.abort.signal.aborted).toBe(true)
    store.delete(a.id); store.delete(b.id)
  })
  it('returns an existing run for duplicate submissions without repeating work', async () => {
    const session = store.create(), turn = messageTurn()
    const { run } = store.begin(session, turn)
    run.status = 'completed'
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const response = await runRoute(req('runs', 'POST', session.id, turn))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ duplicate: true, runId: run.id })
    expect(fetch).not.toHaveBeenCalled()
    store.delete(session.id)
  })
  it('streams and closes a real model-wire clarification turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ count: 1000 })).mockResolvedValueOnce(Response.json({
      choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'question', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Which model and load should I size?"}' } }] } }],
      usage: { completion_tokens: 30 },
    })))
    const session = store.create(), events: StreamEvent[] = []
    const response = await runRoute(req('runs', 'POST', session.id, messageTurn()))
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    await consumeAgentStream(response, event => events.push(event))
    expect(events.at(-1)?.snapshot.run?.status).toBe('awaiting_input')
    expect(snapshot(session).messages.at(-1)?.text).toContain('Which model')
    store.delete(session.id)
  })
})
