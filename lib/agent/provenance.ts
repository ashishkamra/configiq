import { AgentError } from './config'
import type { Receipt } from './contracts'
import { hash } from './store'

/** Hash exact serialized upstream input; publish only configuration digests. */
export function captureRequest(receipt: Receipt, payload: Record<string, unknown>) {
  if (!receipt.provenance) throw new AgentError('INVALID_PROVENANCE', 'Tool provenance is missing.', 502)
  receipt.inputHash = hash(payload)
  const { model_config: modelConfig, ...safe } = payload
  receipt.inputs = safe
  receipt.provenance.modelConfigHash = modelConfig == null ? null : hash(modelConfig)
  receipt.provenance.payloadCaptured = true
  receipt.provenance.inputHashSource = 'wire_payload'
}

/** Preserve safe failed-attempt provenance without pretending it is success. */
export class SizingToolError extends AgentError {
  constructor(public readonly receipt: Receipt, cause: unknown) {
    const error = cause instanceof AgentError ? cause : new AgentError('INVALID_EVIDENCE', 'Sizing arguments or service evidence failed validation.', 502)
    super(error.code, error.message, error.status)
    receipt.status = 'error'; receipt.error = `${error.code}: ${error.message}`
    receipt.metrics = {}; receipt.meetsConstraints = 'unknown'
  }
}
