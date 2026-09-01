import { describe, it, expect } from 'vitest'
import { classifyLoadDb, parseDatabaseUrl } from './load-db'
import { FakeConnector, iccidForKey } from './fake-provider-driver'
import { SCENARIO_CONTRACT, SCENARIOS } from './scenarios'
import { checkFakeDispatchCounts } from './invariants'

describe('load-db safety gate', () => {
  it('requires onesim_load_ prefix — fails closed on other names', () => {
    const gate = classifyLoadDb('postgresql://u:p@localhost:5432/onesim_africa')
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('onesim_load_')
  })

  it('accepts a dedicated load database', () => {
    const gate = classifyLoadDb('postgresql://u:p@localhost:5432/onesim_load_abc')
    expect(gate.ok).toBe(true)
    expect(gate.databaseName).toBe('onesim_load_abc')
    expect(gate.stagingDbUsed).toBe(false)
    expect(gate.productionDbUsed).toBe(false)
  })

  it('rejects staging-like host and prod-like host', () => {
    const s = classifyLoadDb('postgresql://u:p@staging.example.com:5432/onesim_load_x')
    expect(s.ok).toBe(false)
    expect(s.stagingDbUsed).toBe(true)
    const p = classifyLoadDb('postgresql://u:p@prod-db.example.com:5432/onesim_load_x')
    expect(p.ok).toBe(false)
    expect(p.productionDbUsed).toBe(true)
  })

  it('parses DATABASE_URL to names only', () => {
    const parsed = parseDatabaseUrl('postgresql://user:secret@localhost:5432/onesim_load_y')
    expect(parsed.database).toBe('onesim_load_y')
  })
})

describe('fake provider driver — deterministic scenarios', () => {
  it('SUCCESS_SYNC is synchronous with ICCID and ACTIVE', async () => {
    const c = new FakeConnector('AIRHUB', 'SUCCESS_SYNC')
    const r = await c.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y.io' }, orderId: 'o1' } as any)
    expect(r.success).toBe(true)
    expect(r.data?.iccids?.length).toBe(1)
    expect(r.data?.status).toBe('ACTIVE')
    expect(c.dispatchSeen.get('AIRHUB:o1')).toBe(1)
  })

  it('ASYNC_ACCEPTED returns PENDING with reference, then ACTIVE with ICCID on poll', async () => {
    const c = new FakeConnector('AIRHUB', 'ASYNC_ACCEPTED')
    const act = await c.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y.io' }, orderId: 'o2' } as any)
    expect(act.success).toBe(true)
    expect(act.data?.status).toBe('PENDING')
    const s1 = await c.getStatus('o2')
    expect(s1.data?.status).toBe('PENDING')
    const s2 = await c.getStatus('o2')
    expect(s2.data?.status).toBe('ACTIVE')
    expect(s2.data?.iccids?.length).toBe(1)
  })

  it('EXPLICIT_REJECT returns a non-retryable rejection', async () => {
    const c = new FakeConnector('AIRHUB', 'EXPLICIT_REJECT')
    const r = await c.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y.io' }, orderId: 'o3' } as any)
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('PROVIDER_REJECTED')
    expect(r.error?.details?.retryable).toBe(false)
  })

  it('LONG_PENDING stays pending across polls', async () => {
    const c = new FakeConnector('AIRHUB', 'LONG_PENDING')
    await c.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y.io' }, orderId: 'o4' } as any)
    const s1 = await c.getStatus('o4')
    const s5 = await c.getStatus('o4')
    expect(s1.data?.status).toBe('PENDING')
    expect(s5.data?.status).toBe('PENDING')
  })

  it('RATE_LIMITED / HTTP_500 return retryable transport-ish errors', async () => {
    const r1 = await new FakeConnector('AIRHUB', 'RATE_LIMITED').activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y' }, orderId: 'o' } as any)
    expect(r1.error?.code).toBe('RATE_LIMITED')
    const r2 = await new FakeConnector('AIRHUB', 'HTTP_500').activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y' }, orderId: 'o' } as any)
    expect(r2.error?.code).toBe('PROVIDER_UNAVAILABLE')
  })

  it('TIMEOUT_POST_ACCEPT: activation accepted, first poll transient then ACTIVE', async () => {
    const c = new FakeConnector('AIRHUB', 'TIMEOUT_POST_ACCEPT')
    const act = await c.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y' }, orderId: 'o5' } as any)
    expect(act.data?.status).toBe('PENDING')
    const bad = await c.getStatus('o5')
    expect(bad.success).toBe(false)
    const ok = await c.getStatus('o5')
    expect(ok.data?.status).toBe('ACTIVE')
  })

  it('MALFORMED_RESPONSE returns success without reference/ICCID (ambiguous path)', async () => {
    const r = await new FakeConnector('AIRHUB', 'MALFORMED_RESPONSE').activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y' }, orderId: 'o6' } as any)
    expect(r.success).toBe(true)
    expect(r.data?.activationId).toBeFalsy()
    expect(r.data?.iccids ?? []).toHaveLength(0)
  })

  it('dispatch counter increments per logical provider purchase (duplicate detector)', async () => {
    const c = new FakeConnector('AIRHUB', 'SUCCESS_SYNC')
    await c.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y' }, orderId: 'o7' } as any)
    await c.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'x@y' }, orderId: 'o7' } as any)
    expect(c.dispatchSeen.get('AIRHUB:o7')).toBe(2)
    const out = { duplicateProviderDispatches: 0 }
    checkFakeDispatchCounts(c.dispatchSeen, out)
    expect(out.duplicateProviderDispatches).toBe(1)
  })

  it('ICCIDs are deterministic and unique per key', () => {
    const a = iccidForKey('AIRHUB:o1', 'AIRHUB')
    const b = iccidForKey('AIRHUB:o1', 'AIRHUB')
    const c = iccidForKey('AIRHUB:o2', 'AIRHUB')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('scenario contract covers all twelve scenarios', () => {
    expect(SCENARIOS).toHaveLength(12)
    for (const s of SCENARIOS) expect(SCENARIO_CONTRACT[s]).toBeDefined()
  })
})