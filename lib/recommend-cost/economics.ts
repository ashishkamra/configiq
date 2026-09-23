/** Pure cost modeling for an already-sized inference deployment; GPU sizing stays in AISimulators. */
export interface CostScenarioInput {
  gpusNeeded: number
  gpusPerNode: number
  nodes: number
  costPerNodeMonth: number
  otherCostMonth: number
  isl: number
  osl: number
  users: number
  activeHoursDay: number
  dutyCyclePct: number
  workDaysMonth: number
  cacheHitPct: number
  inputTokensPerSecond: number | null
  outputTokensPerSecond: number | null
  outputTokensPerSecondPerUser: number | null
  supportedConcurrency: number
}

export interface CostScenario {
  requiredNodes: number
  monthlyCost: number
  monthlyCapacity: number | null
  monthlyDemand: number | null
  utilizationPct: number | null
  peakConcurrent: number | null
  peakTokensPerSecond: number | null
  peakUtilizationPct: number | null
  overCapacity: boolean
  overConcurrency: boolean
  overPeakCapacity: boolean
  costPerMillionAtCapacity: number | null
  costPerMillionAtDemand: number | null
  inputFraction: number | null
  outputFraction: number | null
  error: string | null
}

export interface ApiModelPrice {
  id: string
  name: string
  provider: string
  source?: string
  price_per_m_input: number
  price_per_m_cached_input?: number | null
  price_per_m_output: number
}

export interface ApiComparison {
  id: string
  name: string
  provider: string
  source?: string
  blendedCostPerMillion: number
  monthlyApiCost: number | null
  breakevenPct: number | null
  usesCacheFallback: boolean
}

const SECONDS_PER_MONTH = 30.44 * 86400

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function positiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function nonnegativeNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/** A missing metric is different from a measured zero or an invalid metric. */
function rateError(value: number | null, name: string): string | null {
  return value == null ? `Missing ${name}` : positiveNumber(value) ? null : `Invalid ${name}`
}

export function computeCostScenario(input: CostScenarioInput): CostScenario {
  const requiredNodes = positiveInteger(input.gpusNeeded) && positiveInteger(input.gpusPerNode)
    ? Math.ceil(input.gpusNeeded / input.gpusPerNode)
    : 0
  const cost = input.nodes * input.costPerNodeMonth + input.otherCostMonth
  const monthlyCost = positiveInteger(input.nodes) && nonnegativeNumber(input.costPerNodeMonth)
    && nonnegativeNumber(input.otherCostMonth) && Number.isFinite(cost) ? cost : 0

  const result: CostScenario = {
    requiredNodes,
    monthlyCost,
    monthlyCapacity: null,
    monthlyDemand: null,
    utilizationPct: null,
    peakConcurrent: null,
    peakTokensPerSecond: null,
    peakUtilizationPct: null,
    overCapacity: false,
    overConcurrency: false,
    overPeakCapacity: false,
    costPerMillionAtCapacity: null,
    costPerMillionAtDemand: null,
    inputFraction: null,
    outputFraction: null,
    error: null,
  }

  const integerFields = [
    ['gpusNeeded', input.gpusNeeded], ['gpusPerNode', input.gpusPerNode],
    ['nodes', input.nodes], ['isl', input.isl], ['osl', input.osl],
    ['users', input.users], ['workDaysMonth', input.workDaysMonth],
  ] as const
  for (const [name, value] of integerFields) {
    if (!positiveInteger(value)) {
      result.error = `${name} must be a positive integer`
      return result
    }
  }
  if (!nonnegativeNumber(input.costPerNodeMonth) || !nonnegativeNumber(input.otherCostMonth)
    || !Number.isFinite(cost)) {
    result.error = 'Monthly costs must be finite and nonnegative'
    return result
  }
  if (input.nodes < requiredNodes) {
    result.error = `At least ${requiredNodes} nodes are required for ${input.gpusNeeded} GPUs`
    return result
  }
  if (!positiveNumber(input.activeHoursDay) || input.activeHoursDay > 24
    || !positiveNumber(input.dutyCyclePct) || input.dutyCyclePct > 100
    || !nonnegativeNumber(input.cacheHitPct) || input.cacheHitPct > 100
    || !positiveNumber(input.supportedConcurrency)) {
    result.error = 'Hours, duty cycle, cache hit rate, or supported concurrency is invalid'
    return result
  }

  const inputError = rateError(input.inputTokensPerSecond, 'input throughput')
  const outputError = rateError(input.outputTokensPerSecond, 'output throughput')
  const userError = rateError(input.outputTokensPerSecondPerUser, 'per-user output throughput')

  // Per-user demand does not depend on cluster goodput, so retain it if the
  // cluster rate is unavailable. Likewise capacity survives missing user rate.
  if (!userError && input.outputTokensPerSecondPerUser !== null) {
    const secondsPerTurn = input.osl / input.outputTokensPerSecondPerUser
    const turnsPerHour = 3600 / secondsPerTurn
    const effectiveHours = input.users * input.activeHoursDay * (input.dutyCyclePct / 100) * input.workDaysMonth
    const demand = turnsPerHour * (input.isl + input.osl) * effectiveHours
    const concurrent = input.users * (input.dutyCyclePct / 100)
    const peak = concurrent * ((input.isl + input.osl) / secondsPerTurn)
    if (positiveNumber(demand) && positiveNumber(concurrent) && positiveNumber(peak)) {
      result.monthlyDemand = demand
      result.peakConcurrent = concurrent
      result.peakTokensPerSecond = peak
      result.overConcurrency = concurrent > input.supportedConcurrency
    } else {
      result.error = 'Demand or peak rate exceeds the supported numeric range'
    }
  }

  if (!inputError && !outputError
    && input.inputTokensPerSecond !== null && input.outputTokensPerSecond !== null) {
    const goodput = input.inputTokensPerSecond + input.outputTokensPerSecond
    const capacity = goodput * SECONDS_PER_MONTH
    const atCapacity = monthlyCost / (capacity / 1e6)
    if (positiveNumber(capacity) && nonnegativeNumber(atCapacity)) {
      result.monthlyCapacity = capacity
      result.costPerMillionAtCapacity = atCapacity
      // API billing uses the tokens in each requested turn, not the relative
      // throughput of two serving phases (which can differ considerably).
      result.inputFraction = input.isl / (input.isl + input.osl)
      result.outputFraction = input.osl / (input.isl + input.osl)
      if (result.monthlyDemand !== null && result.peakTokensPerSecond !== null) {
        const utilization = (result.monthlyDemand / capacity) * 100
        const peakUtilization = (result.peakTokensPerSecond / goodput) * 100
        const atDemand = monthlyCost / (result.monthlyDemand / 1e6)
        if (Number.isFinite(utilization) && Number.isFinite(peakUtilization)
          && nonnegativeNumber(atDemand)) {
          result.utilizationPct = utilization
          result.peakUtilizationPct = peakUtilization
          result.overCapacity = result.monthlyDemand > capacity
          const peakInput = result.peakConcurrent! * input.isl / (input.osl / input.outputTokensPerSecondPerUser!)
          const peakOutput = result.peakConcurrent! * input.outputTokensPerSecondPerUser!
          result.overPeakCapacity = result.peakTokensPerSecond > goodput
            || peakInput > input.inputTokensPerSecond || peakOutput > input.outputTokensPerSecond
          if (!result.overCapacity && !result.overConcurrency && !result.overPeakCapacity) {
            result.costPerMillionAtDemand = atDemand
          }
        } else {
          result.error = 'Utilization or demand cost exceeds the supported numeric range'
        }
      }
    } else {
      result.error = 'Capacity or capacity cost exceeds the supported numeric range'
    }
  }

  result.error ??= inputError ?? outputError ?? userError
  return result
}

/** Compare the sized request's input/output token mix against metered API prices. */
export function compareApiModels(
  scenario: CostScenario,
  cacheHitPct: number,
  models: ApiModelPrice[],
): ApiComparison[] {
  if (!nonnegativeNumber(cacheHitPct) || cacheHitPct > 100) {
    throw new RangeError('cacheHitPct must be between 0 and 100')
  }
  if (scenario.inputFraction === null || scenario.outputFraction === null
    || !nonnegativeNumber(scenario.inputFraction) || !nonnegativeNumber(scenario.outputFraction)) {
    if (models.length === 0) return []
    throw new RangeError('Scenario must have valid throughput fractions')
  }

  return models.map(model => {
    if (!nonnegativeNumber(model.price_per_m_input) || !nonnegativeNumber(model.price_per_m_output)
      || (model.price_per_m_cached_input != null && !nonnegativeNumber(model.price_per_m_cached_input))) {
      throw new RangeError(`Invalid API prices for ${model.id}`)
    }
    const usesCacheFallback = model.price_per_m_cached_input == null
    const cachedPrice = usesCacheFallback ? model.price_per_m_input : model.price_per_m_cached_input!
    const cachedFraction = scenario.inputFraction! * (cacheHitPct / 100)
    const blendedCostPerMillion = (scenario.inputFraction! - cachedFraction) * model.price_per_m_input
      + cachedFraction * cachedPrice + scenario.outputFraction! * model.price_per_m_output
    if (!nonnegativeNumber(blendedCostPerMillion)) {
      throw new RangeError(`Blended API price exceeds the supported numeric range for ${model.id}`)
    }
    const monthlyApiCost = scenario.monthlyDemand !== null && nonnegativeNumber(scenario.monthlyDemand)
      ? blendedCostPerMillion * (scenario.monthlyDemand / 1e6) : null
    const breakevenPct = blendedCostPerMillion > 0 && scenario.costPerMillionAtCapacity !== null
      && nonnegativeNumber(scenario.costPerMillionAtCapacity)
      ? (scenario.costPerMillionAtCapacity / blendedCostPerMillion) * 100 : null
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      ...(model.source === undefined ? {} : { source: model.source }),
      blendedCostPerMillion,
      monthlyApiCost: monthlyApiCost !== null && Number.isFinite(monthlyApiCost) ? monthlyApiCost : null,
      breakevenPct: breakevenPct !== null && Number.isFinite(breakevenPct) ? breakevenPct : null,
      usesCacheFallback,
    }
  })
}

/** Self-hosted unit cost for each integer utilization percentage, 1 through 100. */
export function costCurve(costPerMillionAtCapacity: number): Array<{ utilizationPct: number; costPerMillion: number }> {
  if (!nonnegativeNumber(costPerMillionAtCapacity) || !Number.isFinite(costPerMillionAtCapacity * 100)) {
    throw new RangeError('Capacity cost must be finite and nonnegative across the curve')
  }
  return Array.from({ length: 100 }, (_, index) => ({
    utilizationPct: index + 1,
    costPerMillion: costPerMillionAtCapacity / ((index + 1) / 100),
  }))
}
