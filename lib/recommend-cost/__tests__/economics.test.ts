import { describe, expect, it } from 'vitest'
import { compareApiModels, computeCostScenario, costCurve } from '../economics'
import type { ApiModelPrice, CostScenarioInput } from '../economics'

const input: CostScenarioInput = {
  gpusNeeded: 5,
  gpusPerNode: 4,
  nodes: 2,
  costPerNodeMonth: 1000,
  otherCostMonth: 500,
  isl: 1000,
  osl: 200,
  users: 10,
  activeHoursDay: 8,
  dutyCyclePct: 25,
  workDaysMonth: 20,
  cacheHitPct: 50,
  inputTokensPerSecond: 900,
  outputTokensPerSecond: 100,
  outputTokensPerSecondPerUser: 10,
  supportedConcurrency: 4,
}

const model: ApiModelPrice = {
  id: 'model-1',
  name: 'Example',
  provider: 'Example provider',
  source: 'pricing feed',
  price_per_m_input: 2,
  price_per_m_cached_input: 0.5,
  price_per_m_output: 10,
}

describe('computeCostScenario', () => {
  it('uses prototype turn time, monthly seconds, and request-weighted API fractions', () => {
    const result = computeCostScenario(input)
    const expectedDemand = 10 * (3600 / (200 / 10)) * (1000 + 200) * (8 * 0.25 * 20)
    const capacity = 1000 * 30.44 * 86400
    expect(result.requiredNodes).toBe(2)
    expect(result.monthlyCost).toBe(2500)
    expect(result.monthlyDemand).toBe(expectedDemand)
    expect(result.monthlyCapacity).toBeCloseTo(capacity)
    expect(result.utilizationPct).toBeCloseTo(expectedDemand / capacity * 100)
    expect(result.peakConcurrent).toBe(2.5)
    expect(result.peakTokensPerSecond).toBe(2.5 * 1200 / 20)
    expect(result.peakUtilizationPct).toBe(15)
    expect(result.costPerMillionAtCapacity).toBeCloseTo(2500 / (capacity / 1e6))
    expect(result.costPerMillionAtDemand).toBeCloseTo(2500 / (expectedDemand / 1e6))
    expect(result.inputFraction).toBeCloseTo(1000 / 1200)
    expect(result.outputFraction).toBeCloseTo(200 / 1200)
    expect(result.overCapacity).toBe(false)
    expect(result.overConcurrency).toBe(false)
    expect(result.overPeakCapacity).toBe(false)
    expect(result.error).toBeNull()
  })

  it('accepts minimum legal quantities and zero infrastructure cost', () => {
    const result = computeCostScenario({
      ...input, gpusNeeded: 1, gpusPerNode: 1, nodes: 1,
      users: 1, isl: 1, osl: 1, workDaysMonth: 1,
      activeHoursDay: 24, dutyCyclePct: 100, cacheHitPct: 100,
      costPerNodeMonth: 0, otherCostMonth: 0,
    })
    expect(result.error).toBeNull()
    expect(result.requiredNodes).toBe(1)
    expect(result.costPerMillionAtCapacity).toBe(0)
    expect(result.costPerMillionAtDemand).toBe(0)
  })

  it.each([
    ['gpusNeeded', 0], ['gpusNeeded', 1.5], ['gpusNeeded', Infinity],
    ['gpusPerNode', 0], ['nodes', 1.5], ['nodes', -1],
    ['users', 0], ['users', NaN], ['workDaysMonth', 0],
    ['isl', 0], ['isl', 1.2], ['osl', -1],
  ] as const)('rejects invalid integer %s = %s', (field, value) => {
    const result = computeCostScenario({ ...input, [field]: value })
    expect(result.error).not.toBeNull()
    expect(result.monthlyCapacity).toBeNull()
    expect(result.monthlyDemand).toBeNull()
    expect(result.costPerMillionAtDemand).toBeNull()
  })

  it.each([
    ['costPerNodeMonth', -1], ['costPerNodeMonth', Infinity],
    ['otherCostMonth', NaN], ['otherCostMonth', -1],
    ['activeHoursDay', 0], ['activeHoursDay', 24.1],
    ['dutyCyclePct', 0], ['dutyCyclePct', 101],
    ['cacheHitPct', -1], ['cacheHitPct', 101],
    ['supportedConcurrency', 0], ['supportedConcurrency', Infinity],
  ] as const)('rejects out-of-range %s = %s', (field, value) => {
    const result = computeCostScenario({ ...input, [field]: value })
    expect(result.error).not.toBeNull()
    expect(result.costPerMillionAtDemand).toBeNull()
  })

  it('rejects nodes below the required count, but exposes the required count', () => {
    const result = computeCostScenario({ ...input, nodes: 1 })
    expect(result.requiredNodes).toBe(2)
    expect(result.error).toMatch(/2 nodes/)
    expect(result.monthlyCapacity).toBeNull()
  })

  it.each(['inputTokensPerSecond', 'outputTokensPerSecond'] as const)(
    'keeps independent demand when %s is missing', field => {
      const result = computeCostScenario({ ...input, [field]: null })
      expect(result.error).toMatch(/Missing/)
      expect(result.monthlyCost).toBe(2500)
      expect(result.monthlyDemand).toBeGreaterThan(0)
      expect(result.peakConcurrent).toBe(2.5)
      expect(result.monthlyCapacity).toBeNull()
      expect(result.costPerMillionAtCapacity).toBeNull()
      expect(result.costPerMillionAtDemand).toBeNull()
    },
  )

  it('keeps independent capacity if per-user throughput is missing', () => {
    const result = computeCostScenario({ ...input, outputTokensPerSecondPerUser: null })
    expect(result.error).toMatch(/Missing/)
    expect(result.monthlyCapacity).toBeGreaterThan(0)
    expect(result.costPerMillionAtCapacity).toBeGreaterThan(0)
    expect(result.monthlyDemand).toBeNull()
    expect(result.peakTokensPerSecond).toBeNull()
    expect(result.costPerMillionAtDemand).toBeNull()
  })

  it.each(['inputTokensPerSecond', 'outputTokensPerSecond', 'outputTokensPerSecondPerUser'] as const)(
    'rejects invalid throughput %s without fabricating a value', field => {
      for (const value of [0, -1, NaN, Infinity]) {
        const result = computeCostScenario({ ...input, [field]: value })
        expect(result.error).toMatch(/Invalid/)
        expect(result.costPerMillionAtDemand).toBeNull()
      }
    },
  )

  it('gates demand cost at monthly capacity without clipping utilization', () => {
    const result = computeCostScenario({ ...input, users: 10000, supportedConcurrency: 10000 })
    expect(result.overCapacity).toBe(true)
    expect(result.utilizationPct).toBeGreaterThan(100)
    expect(result.costPerMillionAtDemand).toBeNull()
    expect(result.costPerMillionAtCapacity).toBeGreaterThan(0)
    expect(result.monthlyCost).toBe(2500)
  })

  it('gates demand cost for excess concurrency even with spare throughput', () => {
    const result = computeCostScenario({ ...input, supportedConcurrency: 2 })
    expect(result.overConcurrency).toBe(true)
    expect(result.overCapacity).toBe(false)
    expect(result.overPeakCapacity).toBe(false)
    expect(result.costPerMillionAtDemand).toBeNull()
  })

  it('gates demand cost for peak goodput independently of monthly demand', () => {
    const result = computeCostScenario({
      ...input, inputTokensPerSecond: 100, outputTokensPerSecond: 10,
    })
    expect(result.overCapacity).toBe(false)
    expect(result.overConcurrency).toBe(false)
    expect(result.overPeakCapacity).toBe(true)
    expect(result.peakUtilizationPct).toBeGreaterThan(100)
    expect(result.costPerMillionAtDemand).toBeNull()
  })

  it('allows demand and peak rates exactly at their limits', () => {
    const result = computeCostScenario({
      ...input, supportedConcurrency: 2.5,
      inputTokensPerSecond: 125, outputTokensPerSecond: 25,
    })
    expect(result.peakTokensPerSecond).toBe(150)
    expect(result.peakUtilizationPct).toBe(100)
    expect(result.overCapacity).toBe(false)
    expect(result.overConcurrency).toBe(false)
    expect(result.overPeakCapacity).toBe(false)
    expect(result.costPerMillionAtDemand).toBeGreaterThan(0)
  })

  it('rejects a saturated input stage even when combined throughput has spare capacity', () => {
    const result = computeCostScenario({
      ...input, inputTokensPerSecond: 100, outputTokensPerSecond: 900,
    })
    expect(result.peakTokensPerSecond).toBe(150)
    expect(result.peakUtilizationPct).toBe(15)
    expect(result.overPeakCapacity).toBe(true)
    expect(result.costPerMillionAtDemand).toBeNull()
  })

  it('rejects a saturated output stage despite spare aggregate throughput', () => {
    const result = computeCostScenario({
      ...input, inputTokensPerSecond: 900, outputTokensPerSecond: 20,
    })
    expect(result.overPeakCapacity).toBe(true)
    expect(result.costPerMillionAtDemand).toBeNull()
  })

  it('rejects overflow instead of leaking infinite costs or capacity', () => {
    const result = computeCostScenario({ ...input, inputTokensPerSecond: 1e308, outputTokensPerSecond: 1e308 })
    expect(result.error).not.toBeNull()
    expect(result.monthlyCapacity).toBeNull()
    expect(result.costPerMillionAtDemand).toBeNull()
  })
})

describe('compareApiModels', () => {
  it('blends cache read and sized-request shares, preserving source and actual demand', () => {
    const scenario = computeCostScenario(input)
    const [comparison] = compareApiModels(scenario, 50, [model])
    const blended = (1000 / 1200 / 2) * 2 + (1000 / 1200 / 2) * 0.5 + (200 / 1200) * 10
    expect(comparison).toMatchObject({
      id: model.id, name: model.name, provider: model.provider, source: model.source,
      usesCacheFallback: false,
    })
    expect(comparison.blendedCostPerMillion).toBeCloseTo(blended)
    expect(comparison.monthlyApiCost).toBeCloseTo(blended * (scenario.monthlyDemand! / 1e6))
    expect(comparison.breakevenPct).toBeCloseTo(scenario.costPerMillionAtCapacity! / blended * 100)
  })

  it.each([null, undefined])('falls back to full input price for cached price %s', cached => {
    const [comparison] = compareApiModels(computeCostScenario(input), 100, [
      { ...model, source: undefined, price_per_m_cached_input: cached },
    ])
    expect(comparison.usesCacheFallback).toBe(true)
    expect(comparison.blendedCostPerMillion).toBeCloseTo((1000 / 1200) * 2 + (200 / 1200) * 10)
    expect(comparison).not.toHaveProperty('source')
  })

  it('treats a zero cached price as a valid price, not a fallback', () => {
    const [comparison] = compareApiModels(computeCostScenario(input), 100, [
      { ...model, price_per_m_cached_input: 0 },
    ])
    expect(comparison.usesCacheFallback).toBe(false)
    expect(comparison.blendedCostPerMillion).toBeCloseTo((200 / 1200) * 10)
  })

  it('does not discount uncached input at zero cache hit rate', () => {
    const [comparison] = compareApiModels(computeCostScenario(input), 0, [model])
    expect(comparison.blendedCostPerMillion).toBeCloseTo((1000 / 1200) * 2 + (200 / 1200) * 10)
  })

  it('keeps API monthly cost available even if self-hosted cannot meet demand', () => {
    const scenario = computeCostScenario({ ...input, users: 10000 })
    const [comparison] = compareApiModels(scenario, 0, [model])
    expect(scenario.costPerMillionAtDemand).toBeNull()
    expect(comparison.monthlyApiCost).toBeCloseTo(comparison.blendedCostPerMillion * scenario.monthlyDemand! / 1e6)
  })

  it('keeps numeric breakeven above 100 for UI labeling', () => {
    const [comparison] = compareApiModels(computeCostScenario(input), 0, [
      { ...model, price_per_m_input: 0.001, price_per_m_output: 0.001 },
    ])
    expect(comparison.breakevenPct).toBeGreaterThan(100)
  })

  it('returns null breakeven for a free API and zero for free infrastructure', () => {
    const freeApi = { ...model, price_per_m_input: 0, price_per_m_cached_input: 0, price_per_m_output: 0 }
    const [free] = compareApiModels(computeCostScenario(input), 100, [freeApi])
    expect(free.blendedCostPerMillion).toBe(0)
    expect(free.monthlyApiCost).toBe(0)
    expect(free.breakevenPct).toBeNull()

    const [freeHosting] = compareApiModels(computeCostScenario({
      ...input, costPerNodeMonth: 0, otherCostMonth: 0,
    }), 0, [model])
    expect(freeHosting.breakevenPct).toBe(0)
  })

  it('returns null API monthly cost when demand is unavailable', () => {
    const scenario = computeCostScenario({ ...input, outputTokensPerSecondPerUser: null })
    expect(compareApiModels(scenario, 0, [model])[0].monthlyApiCost).toBeNull()
  })

  it('rejects invalid prices, cache percentages, and unavailable throughput fractions', () => {
    const scenario = computeCostScenario(input)
    for (const value of [-1, NaN, Infinity]) {
      expect(() => compareApiModels(scenario, value, [model])).toThrow(RangeError)
      for (const field of ['price_per_m_input', 'price_per_m_output', 'price_per_m_cached_input'] as const) {
        expect(() => compareApiModels(scenario, 50, [{ ...model, [field]: value }])).toThrow(RangeError)
      }
    }
    expect(() => compareApiModels(scenario, 101, [model])).toThrow(RangeError)
    expect(() => compareApiModels(computeCostScenario({ ...input, inputTokensPerSecond: null }), 0, [model]))
      .toThrow(RangeError)
  })
})

describe('costCurve', () => {
  it('returns one point per percent with inverse utilization pricing', () => {
    const curve = costCurve(2)
    expect(curve).toHaveLength(100)
    expect(curve[0]).toEqual({ utilizationPct: 1, costPerMillion: 200 })
    expect(curve[49]).toEqual({ utilizationPct: 50, costPerMillion: 4 })
    expect(curve[99]).toEqual({ utilizationPct: 100, costPerMillion: 2 })
    expect(costCurve(0)[0].costPerMillion).toBe(0)
  })

  it.each([-1, NaN, Infinity, 1e308])('rejects invalid or overflowing cost %s', value => {
    expect(() => costCurve(value)).toThrow(RangeError)
  })
})
