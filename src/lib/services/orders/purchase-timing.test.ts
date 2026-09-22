import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPurchaseTiming, type PurchaseTiming, type PurchaseTimingNow, type PurchaseTimingEmit } from './purchase-timing'

interface Harness {
  now: PurchaseTimingNow
  emit: PurchaseTimingEmit
  events: Record<string, unknown>[]
  timing: PurchaseTiming
}

function clockFrom(sequence: number[]): PurchaseTimingNow {
  let i = 0
  return () => sequence[Math.min(i++, sequence.length - 1)]
}

function harness(sequence: number[], meta: any = {}): Harness {
  const events: Record<string, unknown>[] = []
  const now = clockFrom(sequence)
  const emit: PurchaseTimingEmit = (p) => events.push(p)
  const timing = createPurchaseTiming(meta, now, emit)
  return { now, emit, events, timing }
}

describe('purchase timing — structured elapsed-ms stages', () => {
  it('records per-stage elapsed ms and total ms with deterministic fake timing', () => {
    const { timing, events } = harness([100, 100, 150, 150, 175, 175, 200])
    timing.start('orderCreated')
    timing.end('orderCreated') // 100 -> 150 => 50ms
    timing.start('walletReserved')
    timing.end('walletReserved') // 150 -> 175 => 25ms
    timing.start('dispatch')
    timing.end('dispatch') // 175 -> 200 => 25ms
    timing.complete()
    expect(events).toHaveLength(1)
    const e = events[0] as any
    expect(e.event).toBe('purchase_complete')
    expect(e.totalMs).toBe(100) // 200 - 100
    expect(e.stageMs.orderCreated).toBe(50)
    expect(e.stageMs.walletReserved).toBe(25)
    expect(e.stageMs.dispatch).toBe(25)
  })

  it('emits exactly ONE structured completion event (no per-stage noise)', () => {
    const { timing, events } = harness([0, 0, 5, 5])
    timing.start('a'); timing.end('a'); timing.start('b'); timing.end('b')
    timing.complete()
    timing.complete()
    expect(events).toHaveLength(2) // one per complete() call, never per stage
  })

  it('allowlists safe metadata only — never payload/activationCode/iccid fields', () => {
    const { timing, events } = harness([0, 1, 1])
    timing.start('x'); timing.end('x')
    timing.complete()
    const e = events[0]
    expect(e).not.toHaveProperty('payload')
    expect(e).not.toHaveProperty('activationCode')
    expect(e).not.toHaveProperty('iccid')
    expect(e).not.toHaveProperty('qrCode')
    expect(e).not.toHaveProperty('providerResponse')
  })

  it('includes allowlisted scalar metadata (order id, provider code, operation, attempt)', () => {
    const { timing, events } = harness([10, 12, 12], {
      orderId: 'order-1', providerCode: 'AIRHUB', operation: 'purchase', attemptNumber: 1, correlationId: 'c-1',
    })
    timing.start('dispatch'); timing.end('dispatch'); timing.complete()
    const e = events[0] as any
    expect(e.orderId).toBe('order-1')
    expect(e.providerCode).toBe('AIRHUB')
    expect(e.operation).toBe('purchase')
    expect(e.attemptNumber).toBe(1)
    expect(e.correlationId).toBe('c-1')
  })

  it('18: instrumentation never breaks purchase execution even when the clock throws', () => {
    const dying: PurchaseTimingNow = () => { throw new Error('clock fail') }
    const events: Record<string, unknown>[] = []
    const timing = createPurchaseTiming({}, dying, (p) => events.push(p))
    expect(() => timing.start('a')).not.toThrow()
    expect(() => timing.end('a')).not.toThrow()
    expect(() => timing.complete()).not.toThrow()
    // Degrades safely: a completion event is still produced with a numeric total.
    expect(events).toHaveLength(1)
    expect(typeof (events[0] as any).totalMs).toBe('number')
  })
})