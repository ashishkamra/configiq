import { createHash, randomUUID } from 'node:crypto'
import { AgentError, LIMITS } from './config'
import { isActive, type Proposal, type Receipt, type RunStatus, type Scenario, type Snapshot, type Turn } from './contracts'

export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export interface Run {
  id: string; status: RunStatus; message: string; startedAt: number; revision: number
  turnId: string; turnHash: string; abort: AbortController
}
export interface Session {
  id: string; touchedAt: number; revision: number; scenario: Scenario | null
  approved: boolean; proposal: Proposal | null; receipts: Receipt[]
  messages: Snapshot['messages']; runs: Run[]
  modelConfigs: Map<string, Record<string, unknown>>
}
export function snapshot(session: Session): Snapshot {
  const run = session.runs.at(-1)
  return { revision: session.revision, scenario: session.scenario, approved: session.approved,
    proposal: session.proposal, receipts: session.receipts, messages: session.messages,
    run: run ? { id: run.id, status: run.status, message: run.message, startedAt: run.startedAt } : null }
}
export function remember(session: Session, role: 'user' | 'assistant', text: string) {
  session.messages.push({ role, text: text.slice(0, 16_384) })
  session.messages = session.messages.slice(-10)
  session.touchedAt = Date.now()
}
export function propose(session: Session, scenario: Scenario, assumptions: string[], source: Proposal['source']): Proposal {
  session.revision++
  session.approved = false
  session.scenario = scenario
  session.receipts = []
  session.proposal = { id: randomUUID(), revision: session.revision, scenario, assumptions,
    source, expiresAt: Date.now() + LIMITS.proposalTtl }
  return session.proposal
}

export class SessionStore {
  private sessions = new Map<string, Session>()
  create(now = Date.now()): Session {
    this.sweep(now)
    if (this.sessions.size >= LIMITS.sessions) throw new AgentError('BUSY', 'The assistant has reached its session limit.', 429)
    const session: Session = { id: randomUUID(), touchedAt: now, revision: 0, scenario: null,
      approved: false, proposal: null, receipts: [], messages: [], runs: [], modelConfigs: new Map() }
    this.sessions.set(session.id, session)
    return session
  }
  get(id: string | undefined, now = Date.now()): Session {
    this.sweep(now)
    const session = id ? this.sessions.get(id) : undefined
    if (!session) throw new AgentError('SESSION_EXPIRED', 'This conversation expired or the service restarted. Start a new conversation.', 404)
    session.touchedAt = now
    return session
  }
  delete(id: string) {
    this.sessions.get(id)?.runs.forEach(run => run.abort.abort())
    this.sessions.delete(id)
  }
  sweep(now = Date.now()) {
    for (const session of this.sessions.values()) {
      if (now - session.touchedAt > LIMITS.sessionTtl) this.delete(session.id)
    }
  }
  checkSize(session: Session) {
    if (Buffer.byteLength(JSON.stringify({ ...snapshot(session), configs: [...session.modelConfigs] })) > LIMITS.sessionBytes) {
      this.delete(session.id)
      throw new AgentError('SESSION_FULL', 'Conversation storage is full. Start a new conversation.', 413)
    }
  }
  begin(session: Session, turn: Turn): { run: Run; duplicate: boolean } {
    const old = session.runs.find(run => run.turnId === turn.clientTurnId)
    if (old) {
      if (old.turnHash !== hash(turn)) throw new AgentError('CONFLICT', 'This turn identifier was already used with different input.', 409)
      return { run: old, duplicate: true }
    }
    if (session.runs.some(run => isActive(run.status))) throw new AgentError('CONFLICT', 'A run is already active in this conversation.', 409)
    if (turn.revision !== session.revision) throw new AgentError('CONFLICT', 'The scenario changed. Refresh before continuing.', 409)
    // Never evict idempotency records while the session is live.
    if (session.runs.length >= 64) throw new AgentError('SESSION_FULL', 'Start a new conversation to continue.', 413)
    if (turn.event.type === 'approve') {
      const proposal = session.proposal
      if (!proposal || proposal.id !== turn.event.proposalId || proposal.revision !== session.revision || proposal.expiresAt <= Date.now()) {
        throw new AgentError('CONFLICT', 'This proposal expired or changed. Review a new proposal.', 409)
      }
      session.approved = true; session.proposal = null
    } else {
      // User text could change constraints. Fail closed until a new proposal is approved.
      session.approved = false; session.proposal = null
    }
    const run: Run = { id: randomUUID(), turnId: turn.clientTurnId, turnHash: hash(turn),
      revision: session.revision, status: 'queued', message: 'Waiting for the assistant', startedAt: Date.now(), abort: new AbortController() }
    session.runs.push(run)
    return { run, duplicate: false }
  }
}
const runtime = globalThis as typeof globalThis & { configiqAgentStoreV1?: SessionStore }
export const store = runtime.configiqAgentStoreV1 ??= new SessionStore()
