import { z } from 'zod'
import { gatewayTimeoutSeconds } from './timeout'
import { configuredUrl } from '@/lib/agent/config'
import { fetchJson } from '@/lib/agent/http'

const id = z.string().min(1).max(200).regex(/^[\w./-]+$/)
const Model = z.union([id, z.object({ id })])
const System = z.object({ id, name: z.string().max(200).optional(), memory_bytes: z.number().positive().nullish() })
export async function fetchSizingCatalog(signal: AbortSignal) {
  const base = configuredUrl(process.env.AISIMULATORS_GATEWAY_URL)
  const timed = AbortSignal.any([signal, AbortSignal.timeout(gatewayTimeoutSeconds(30) * 1000)])
  const [models, systems] = await Promise.all([
    fetchJson(`${base}/models?include=specs`, { signal: timed }, 2 * 1024 * 1024),
    fetchJson(`${base}/systems?include=specs`, { signal: timed }, 2 * 1024 * 1024),
  ])
  return {
    models: z.object({ models: z.array(Model).max(10_000) }).parse(models).models.map(m => typeof m === 'string' ? m : m.id),
    systems: z.object({ systems: z.array(System).max(2000) }).parse(systems).systems,
  }
}
export type SizingCatalog = Awaited<ReturnType<typeof fetchSizingCatalog>>
