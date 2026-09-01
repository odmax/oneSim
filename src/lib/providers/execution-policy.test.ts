import { describe, it, expect } from 'vitest'
import {
  normalizeProviderExecutionConfig,
  resolveProviderExecutionPolicy,
  laneLimitForOperation,
} from './execution-policy'

describe('provider execution policy', () => {
  it('unset config → all null (unlimited, preserves current behavior)', () => {
    const p = resolveProviderExecutionPolicy({ id: 'p1', config: {} })
    expect(p.purchaseConcurrency).toBeNull()
    expect(p.statusConcurrency).toBeNull()
    expect(p.purchaseTimeoutMs).toBeNull()
    expect(p.backoffMs).toBeNull()
  })

  it('reads typed execution config from provider.config', () => {
    const p = resolveProviderExecutionPolicy({
      id: 'p1',
      config: { execution: { purchaseConcurrency: 3, statusConcurrency: 5 } },
    })
    expect(p.purchaseConcurrency).toBe(3)
    expect(p.statusConcurrency).toBe(5)
  })

  it('bounds-validates concurrency (min 1, max 100); invalid falls back to null', () => {
    const valid = normalizeProviderExecutionConfig({ purchaseConcurrency: 100 })
    expect(valid.purchaseConcurrency).toBe(100)
    for (const bad of [0, -1, 1.5, 101, 999999, '5', null, true]) {
      const n = normalizeProviderExecutionConfig({ purchaseConcurrency: bad })
      expect(n.purchaseConcurrency).toBeUndefined()
    }
  })

  it('bounds-validates timeouts/backoff', () => {
    expect(normalizeProviderExecutionConfig({ purchaseTimeoutMs: 300_000 }).purchaseTimeoutMs).toBe(300_000)
    expect(normalizeProviderExecutionConfig({ purchaseTimeoutMs: 1_000_000 }).purchaseTimeoutMs).toBeUndefined()
    expect(normalizeProviderExecutionConfig({ purchaseTimeoutMs: 50 }).purchaseTimeoutMs).toBeUndefined()
    expect(normalizeProviderExecutionConfig({ backoffMs: 3_600_000 }).backoffMs).toBe(3_600_000)
    expect(normalizeProviderExecutionConfig({ backoffMs: 10 }).backoffMs).toBeUndefined()
  })

  it('laneLimitForOperation: purchase ops use purchaseConcurrency; status ops use statusConcurrency', () => {
    const p = resolveProviderExecutionPolicy({ id: 'p1', config: { execution: { purchaseConcurrency: 2, statusConcurrency: 7 } } })
    expect(laneLimitForOperation(p, 'PURCHASE_ESIM')).toBe(2)
    expect(laneLimitForOperation(p, 'purchase')).toBe(2)
    expect(laneLimitForOperation(p, 'GET_STATUS')).toBe(7)
    expect(laneLimitForOperation(p, 'TOP_UP')).toBe(7)
    expect(laneLimitForOperation(p, undefined)).toBe(7)
  })

  it('laneLimitForOperation: no config → null (no lane)', () => {
    const p = resolveProviderExecutionPolicy({ id: 'p1', config: {} })
    expect(laneLimitForOperation(p, 'PURCHASE_ESIM')).toBeNull()
    expect(laneLimitForOperation(p, 'GET_STATUS')).toBeNull()
  })

  it('malformed config object is safe', () => {
    const p = resolveProviderExecutionPolicy({ id: 'p1', config: 'not-an-object' })
    expect(p.purchaseConcurrency).toBeNull()
    const p2 = resolveProviderExecutionPolicy({ id: 'p2', config: { execution: { purchaseConcurrency: '3' } } })
    expect(p2.purchaseConcurrency).toBeNull()
  })
})