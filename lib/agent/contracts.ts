import { z } from 'zod'
import { RecommendRequestSchema } from '@/lib/api/schemas'

export const identifier = z.string().min(1).max(200).regex(/^[\w./-]+$/)
const count = z.number().int().positive().max(1_000_000)
const positive = z.number().positive().max(1_000_000_000)
export const ScenarioSchema = z.object({
  model_path: identifier,
  systems: z.array(identifier).min(1).max(3).refine(v => new Set(v).size === v.length),
  backend: z.enum(['vllm', 'sglang', 'tensorrt-llm']),
  backend_version: z.string().max(80).nullable(),
  isl: count, osl: count, ttft: positive, tpot: positive,
  target_concurrency: count.nullable(), target_request_rate: positive.nullable(),
  request_latency: positive.nullable(), prefix: z.number().int().nonnegative().max(1_000_000),
  objective: z.enum(['satisfy_constraints', 'minimize_gpu_count', 'minimize_ttft']),
}).strict().refine(v => (v.target_concurrency !== null) !== (v.target_request_rate !== null),
  'Choose concurrency or request rate, not both')
  .refine(v => v.prefix <= v.isl, 'Prefix must not exceed input tokens')
export type Scenario = z.infer<typeof ScenarioSchema>
export function sizingRequest(scenario: Scenario, system: string) {
  if (!scenario.systems.includes(system)) throw new Error('System is outside the approved scope')
  const { systems: _systems, objective: _objective, ...values } = scenario
  return RecommendRequestSchema.parse({ ...values, system })
}

export const TurnSchema = z.object({
  clientTurnId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('message'), text: z.string().trim().min(1).max(16_384) }).strict(),
    z.object({ type: z.literal('edit'), scenario: ScenarioSchema }).strict(),
    z.object({ type: z.literal('approve'), proposalId: z.string().uuid() }).strict(),
  ]),
}).strict()
export type Turn = z.infer<typeof TurnSchema>

export const ToolSchemas = {
  search_catalog: z.object({ query: z.string().max(120) }).strict(),
  resolve_model: z.object({ model_path: identifier }).strict(),
  propose_scenario: z.object({ scenario: ScenarioSchema, assumptions: z.array(z.string().min(1).max(200)).max(16) }).strict(),
  ask_user: z.object({ question: z.string().min(1).max(800) }).strict(),
  recommend_configuration: z.object({ system: identifier }).strict(),
  estimate_configuration: z.object({ system: identifier, tp_size: count, pp_size: count, batch_size: count }).strict(),
  inspect_memory: z.object({ system: identifier, tp_size: count, pp_size: count, max_batch_size: count, max_num_tokens: count }).strict(),
  compare_results: z.object({ resultIds: z.array(z.string().uuid()).min(1).max(3) }).strict(),
  finish: z.object({ resultIds: z.array(z.string().uuid()).max(4) }).strict(),
} as const
export type ToolName = keyof typeof ToolSchemas
export const ToolNameSchema = z.enum(Object.keys(ToolSchemas) as [ToolName, ...ToolName[]])
export const StatusSchema = z.enum(['queued', 'planning', 'executing', 'verifying', 'awaiting_input', 'awaiting_confirmation', 'completed', 'partial', 'failed', 'cancelled'])
export type RunStatus = z.infer<typeof StatusSchema>
export const isActive = (status: RunStatus) => ['queued', 'planning', 'executing', 'verifying'].includes(status)

export const MetricSchema = z.object({ label: z.string().max(100), value: z.number().nonnegative().nullable(), unit: z.string().max(32) }).strict()
export const AGENT_PROMPT_VERSION = '2' as const
export const ReceiptProvenanceSchema = z.object({
  contractVersion: z.literal('2'), promptVersion: z.literal(AGENT_PROMPT_VERSION),
  endpoint: z.enum(['recommend', 'estimate', 'memory']),
  payloadCaptured: z.boolean(),
  inputHashSource: z.enum(['wire_payload', 'tool_arguments']),
  requestIdSource: z.enum(['configiq_adapter', 'none']),
  modelConfigHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  servingModelId: z.string().max(200).nullable(),
  // Operator-declared artifact revision, not verification of the running server.
  servingModelRevision: z.string().max(200).nullable(),
}).strict()
export const ReceiptSchema = z.object({
  id: z.string().uuid(), revision: z.number().int(), inputHash: z.string(),
  tool: ToolNameSchema, system: identifier, timestamp: z.string(), requestId: z.string().nullable(),
  status: z.enum(['success', 'error']), error: z.string().nullable(),
  metrics: z.record(z.string(), MetricSchema), warnings: z.array(z.string().max(500)).max(20),
  meetsConstraints: z.enum(['yes', 'no', 'unknown']),
  inputs: z.record(z.string(), z.unknown()),
  // Optional for old snapshots/test transports; real tool receipts always carry it.
  provenance: ReceiptProvenanceSchema.optional(),
}).strict()
export type Receipt = z.infer<typeof ReceiptSchema>
export const ProposalSchema = z.object({
  id: z.string().uuid(), revision: z.number().int(), scenario: ScenarioSchema,
  assumptions: z.array(z.string()), expiresAt: z.number(),
  source: z.enum(['agent_proposal', 'user_edit']),
}).strict()
export type Proposal = z.infer<typeof ProposalSchema>
export const SnapshotSchema = z.object({
  revision: z.number().int(), scenario: ScenarioSchema.nullable(), approved: z.boolean(),
  proposal: ProposalSchema.nullable(), receipts: z.array(ReceiptSchema),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() }).strict()),
  run: z.object({ id: z.string().uuid(), status: StatusSchema, message: z.string(), startedAt: z.number() }).strict().nullable(),
}).strict()
export type Snapshot = z.infer<typeof SnapshotSchema>
export const StreamEventSchema = z.object({
  runId: z.string().uuid(), sequence: z.number().int().positive(),
  type: z.enum(['run.started', 'state.updated', 'tool.started', 'tool.completed', 'run.finished']),
  snapshot: SnapshotSchema,
}).strict()
export type StreamEvent = z.infer<typeof StreamEventSchema>

// A session-scoped, schema-validated browser handoff; it never initiates calculation.
export const HANDOFF_KEY = 'configiq.agent.sizing-draft.v1'
export const HandoffSchema = z.object({ scenario: ScenarioSchema, system: identifier, createdAt: z.number() }).strict()
  .refine(v => v.scenario.systems.includes(v.system))
