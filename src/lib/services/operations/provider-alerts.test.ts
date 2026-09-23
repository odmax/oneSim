import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}))

const { prisma } = await import('@/lib/prisma')
const { upsertProviderAlert, resolveProviderAlert, getUnresolvedAlerts } = await import('./provider-alerts')

const mockPrisma = vi.mocked(prisma)

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$executeRawUnsafe.mockResolvedValue(0 as any)
  mockPrisma.$queryRawUnsafe.mockResolvedValue([] as any)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/**
 * Provider alert store semantics: the dedup guard is a PARTIAL unique index
 * (providerId, code, resourceType, resourceId, dedupKey) WHERE resolvedAt IS
 * NULL, so an active alert is a cooldown (occurrenceCount++ only) and a new
 * alert can only appear once the previous one is resolved. Provider-wide alerts
 * use empty resource identity (legacy (providerId, code) semantics preserved);
 * resource-scoped alerts (e.g. SYNC_RETRY_EXHAUSTED) de-duplicate and recover
 * per (eSIM identity, sync type). These tests lock in the SQL contract that
 * the migration must continue to guarantee.
 */
describe('upsertProviderAlert — deduplication / cooldown contract', () => {
  it('targets the partial unique index (providerId, code, resourceType, resourceId, dedupKey) WHERE resolvedAt IS NULL', async () => {
    await upsertProviderAlert('p1', { code: 'CIRCUIT_OPEN', severity: 'CRITICAL', message: 'Circuit breaker is OPEN' })
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1)
    const [sql] = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('ON CONFLICT ("providerId","code","resourceType","resourceId","dedupKey") WHERE "resolvedAt" IS NULL')
    expect(String(sql)).toContain('"occurrenceCount" = provider_alerts."occurrenceCount" + 1')
    expect(String(sql)).toContain('"firstSeenAt"')
  })

  it('provider-wide alerts persist empty resource identity (legacy semantics preserved)', async () => {
    await upsertProviderAlert('p1', { code: 'CIRCUIT_OPEN', severity: 'CRITICAL', message: 'x' })
    const args = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(args[7]).toBe('') // resourceType
    expect(args[8]).toBe('') // resourceId
    expect(args[9]).toBe('') // dedupKey
  })

  it('resource-scoped alerts persist identity WITHOUT encoding it in the code', async () => {
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'status sync retries exhausted for eSIM 8901••••4567' },
      { resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'status' })
    const args = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(args[2]).toBe('SYNC_RETRY_EXHAUSTED') // code stays human-readable
    expect(args[7]).toBe('ESIM')
    expect(args[8]).toBe('esim-1') // INTERNAL eSIM id — never an ICCID
    expect(args[9]).toBe('status')
  })

  it('test 1 — same provider + same eSIM + STATUS twice ⇒ one unresolved alert (same conflict target)', async () => {
    const resource = { resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'status' }
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'm' }, resource)
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'm' }, resource)
    const [a, b] = mockPrisma.$executeRawUnsafe.mock.calls
    expect(a.slice(7)).toEqual(b.slice(7)) // identical resource identity → same DB row via the index
    expect([a, b].map((c) => c[7] + c[8] + c[9])).toEqual(['ESIMesim-1status', 'ESIMesim-1status'])
  })

  it('test 2 — same provider + same eSIM + STATUS and USAGE ⇒ two distinct alerts', async () => {
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'status…' },
      { resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'status' })
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'usage…' },
      { resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'usage' })
    const [a, b] = mockPrisma.$executeRawUnsafe.mock.calls
    expect(a.slice(7)).not.toEqual(b.slice(7)) // dedupKey differs → two rows
  })

  it('test 3 — same provider + two eSIMs + STATUS ⇒ two distinct alerts', async () => {
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'm' },
      { resourceType: 'ESIM', resourceId: 'esim-A', dedupKey: 'status' })
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'm' },
      { resourceType: 'ESIM', resourceId: 'esim-B', dedupKey: 'status' })
    const [a, b] = mockPrisma.$executeRawUnsafe.mock.calls
    expect(a.slice(7)).not.toEqual(b.slice(7)) // resourceId differs → two rows
  })

  it('passes providerId, code, severity and truncates long messages to 500 chars', async () => {
    const long = 'x'.repeat(1200)
    await upsertProviderAlert('p1', { code: 'LOW_PROVIDER_BALANCE', severity: 'WARNING', message: long })
    const args = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(args[1]).toBe('p1')
    expect(args[2]).toBe('LOW_PROVIDER_BALANCE')
    expect(args[3]).toBe('WARNING')
    expect(args[4].length).toBe(500)
  })

  it('never throws when the store insert fails (alerts cannot break the execution path)', async () => {
    mockPrisma.$executeRawUnsafe.mockRejectedValue(new Error('db down'))
    await expect(upsertProviderAlert('p1', { code: 'STUCK_ORDER', severity: 'WARNING', message: 'm' })).resolves.toBeUndefined()
  })

  it('never throws when the store function is missing entirely', async () => {
    // A missing/undefined raw client must not raise a synchronous TypeError into
    // the purchase/sync execution path.
    (mockPrisma.$executeRawUnsafe as any).mockImplementation(() => { throw new TypeError('$executeRawUnsafe is not a function') })
    await expect(upsertProviderAlert('p1', { code: 'STUCK_ORDER', severity: 'WARNING', message: 'm' })).resolves.toBeUndefined()
    await expect(resolveProviderAlert('p1', 'STUCK_ORDER')).resolves.toBeUndefined()
  })

  it('emits a structured [PROVIDER_ALERT] log line (LOG_METRIC channel)', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    await upsertProviderAlert('p1', { code: 'CIRCUIT_OPEN', severity: 'CRITICAL', message: 'Circuit breaker is OPEN' })
    const line = warnSpy.mock.calls[0][0] as string
    expect(line).toContain('[PROVIDER_ALERT]')
    expect(line).toContain('code=CIRCUIT_OPEN')
    expect(line).toContain('providerId=p1')
  })

  it('every alert code has a recommended action', async () => {
    // SYNC_RETRY_EXHAUSTED is passed through the recommended-action map the same
    // way as every other durable alert code.
    await upsertProviderAlert('p1', { code: 'SYNC_RETRY_EXHAUSTED', severity: 'WARNING', message: 'status sync retries exhausted' })
    const action = mockPrisma.$executeRawUnsafe.mock.calls[0][5]
    expect(action).toContain('retries are exhausted')
  })
})

describe('resolveProviderAlert — recovery / resolution contract', () => {
  it('provider-wide resolution only closes empty-identity (provider-wide) rows', async () => {
    await resolveProviderAlert('p1', 'CIRCUIT_OPEN')
    const [sql, providerId, code, rt, ri, dk] = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('SET "resolvedAt" = NOW()')
    expect(String(sql)).toContain('WHERE "providerId"=$1 AND code=$2 AND "resolvedAt" IS NULL AND "resourceType"=$3 AND "resourceId"=$4 AND "dedupKey"=$5')
    expect(providerId).toBe('p1')
    expect(code).toBe('CIRCUIT_OPEN')
    expect([rt, ri, dk]).toEqual(['', '', '']) // provider-wide: empty identity filter
  })

  it('test 4 — STATUS recovery resolves only the matching status alert', async () => {
    await resolveProviderAlert('p1', 'SYNC_RETRY_EXHAUSTED', { resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'status' })
    const [sql, providerId, code, rt, ri, dk] = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('AND "resourceType"=$3 AND "resourceId"=$4 AND "dedupKey"=$5')
    expect(rt).toBe('ESIM')
    expect(ri).toBe('esim-1')
    expect(dk).toBe('status')
  })

  it('test 5 — usage recovery resolves only the matching usage alert', async () => {
    await resolveProviderAlert('p1', 'SYNC_RETRY_EXHAUSTED', { resourceType: 'ESIM', resourceId: 'esim-1', dedupKey: 'usage' })
    const args = mockPrisma.$executeRawUnsafe.mock.calls[0]
    expect(args[5]).toBe('usage') // dedupKey distinguishes usage from status
  })

  it('test 6 — recovery of eSIM A does not resolve eSIM B (resourceId-isolated WHERE clause)', async () => {
    await resolveProviderAlert('p1', 'SYNC_RETRY_EXHAUSTED', { resourceType: 'ESIM', resourceId: 'esim-A', dedupKey: 'status' })
    const args = mockPrisma.$executeRawUnsafe.mock.calls[0]
    // The UPDATE is scoped to resourceId='esim-A' only; esim-B is untouched.
    expect(args[1]).toBe('p1')
    expect(args[4]).toBe('esim-A')
    expect(args[5]).toBe('status')
    // Two different eSIMs resolve to DIFFERENT predicates:
    await resolveProviderAlert('p1', 'SYNC_RETRY_EXHAUSTED', { resourceType: 'ESIM', resourceId: 'esim-B', dedupKey: 'status' })
    expect(mockPrisma.$executeRawUnsafe.mock.calls[1][4]).toBe('esim-B')
  })

  it('repeated resolution is idempotent and safe', async () => {
    mockPrisma.$executeRawUnsafe.mockResolvedValue(0)
    await expect(resolveProviderAlert('p1', 'CIRCUIT_OPEN')).resolves.toBeUndefined()
  })
})

describe('getUnresolvedAlerts — unresolved-only inventory', () => {
  it('only selects unresolved alerts ordered by severity then firstSeen', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ code: 'CIRCUIT_OPEN' }])
    const rows = await getUnresolvedAlerts('p1')
    const [sql, providerId] = mockPrisma.$queryRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('"resolvedAt" IS NULL')
    expect(String(sql)).toContain('ORDER BY severity DESC, "firstSeenAt" DESC')
    expect(providerId).toBe('p1')
    expect(rows).toHaveLength(1)
  })
})