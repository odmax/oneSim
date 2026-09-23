import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    eSIM: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    usageRecord: { create: vi.fn(), findMany: vi.fn() },
    usageSession: { create: vi.fn(), count: vi.fn() },
    usageAlert: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('@/lib/auth/config', () => ({
  authOptions: {},
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
}))

vi.mock('@/lib/catalog-events', () => ({
  emitEvent: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { getServerSession } = await import('next-auth')
const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
const { emitEvent } = await import('@/lib/catalog-events')
const { telnaSyncUsage, telnaSyncSessions, telnaSyncBalances, telnaGenerateAlerts } = await import('./telna-usage-analytics')

const mockPrisma = vi.mocked(prisma)
const mockSession = vi.mocked(getServerSession)
const mockBuild = vi.mocked(buildConnectorFromProvider)

const ICCID = '89012345678901234567'

function esimRow() {
  return {
    id: 'esim-1',
    iccid: ICCID,
    purchase: { package: { providerId: 'telna-1' } },
  } as any
}

function adminSession() {
  mockSession.mockResolvedValue({ user: { id: 'admin-1', role: 'INTERNAL_ADMIN' } } as any)
}

function fakeConnector() {
  return {
    getSimUsage: vi.fn().mockResolvedValue({ success: true, data: { usage: { iccid: ICCID, bytes_used: 1048576, data_used_mb: 1, percentage_used: 10 } } }),
    listSimSessions: vi.fn().mockResolvedValue({ success: true, data: { items: [], total: 0 } }),
    getSimBalances: vi.fn().mockResolvedValue({ success: true, data: { balance: { iccid: ICCID, data_remaining_mb: 500, data_remaining_bytes: 524288000 } } }),
  }
}

describe('telna-usage-analytics log masking', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    adminSession()
    mockPrisma.eSIM.findUnique.mockResolvedValue(esimRow())
    mockPrisma.eSIM.update.mockResolvedValue({})
    mockPrisma.usageRecord.create.mockResolvedValue({})
    mockPrisma.usageSession.create.mockResolvedValue({})
    mockPrisma.usageRecord.findMany.mockResolvedValue([])
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('telnaSyncUsage logs masked ICCID, never the raw ICCID', async () => {
    mockBuild.mockResolvedValue(fakeConnector() as any)
    const result = await telnaSyncUsage('esim-1')
    expect(result.success).toBe(true)
    expect(logSpy).toHaveBeenCalled()
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      const line = String(args)
      expect(line).not.toContain(ICCID)
      if (line.includes('[TELNA_USAGE]')) expect(line).toContain('8901••••4567')
    }
  })

  it('telnaSyncSessions logs masked ICCID, never the raw ICCID', async () => {
    mockBuild.mockResolvedValue(fakeConnector() as any)
    const result = await telnaSyncSessions('esim-1')
    expect(result.success).toBe(true)
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      const line = String(args)
      expect(line).not.toContain(ICCID)
      if (line.includes('[TELNA_SESSION]')) expect(line).toContain('8901••••4567')
    }
  })

  it('telnaSyncBalances logs masked ICCID, never the raw ICCID', async () => {
    mockBuild.mockResolvedValue(fakeConnector() as any)
    const result = await telnaSyncBalances('esim-1')
    expect(result.success).toBe(true)
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      const line = String(args)
      expect(line).not.toContain(ICCID)
      if (line.includes('[TELNA_BALANCE]')) expect(line).toContain('8901••••4567')
    }
  })
})

describe('telnaGenerateAlerts — redaction, race-safe dedup, recovery, terminal skip', () => {
  const TERMINAL = ['EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']

  function rawCalls() {
    return mockPrisma.$executeRawUnsafe.mock.calls
  }

  function inserts() {
    return rawCalls().filter(([sql]) => String(sql).includes('INSERT INTO usage_alerts'))
  }

  function updates() {
    return rawCalls().filter(([sql]) => String(sql).includes('UPDATE usage_alerts'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    adminSession()
    mockPrisma.eSIM.findMany.mockResolvedValue([esimRow()])
    mockPrisma.usageRecord.findMany.mockResolvedValue([])
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1 as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('persists alerts with MASKED ICCIDs — never the full ICCID in alert text', async () => {
    const result = await telnaGenerateAlerts()
    expect(result.success).toBe(true)
    expect(result.alertCount).toBe(1)
    const [sql, esimId, alertType] = inserts()[0]
    expect(String(sql)).toContain('usage_alerts')
    expect(esimId).toBe('esim-1')
    expect(alertType).toBe('NO_ACTIVITY')
    const message = rawCalls()[0][4]
    expect(message).not.toContain(ICCID)
    expect(message).toContain('8901••••4567')
  })

  it('is RACE-SAFE: the insert targets the partial unique index and a lost conflict creates nothing', async () => {
    // Simulate two concurrent attempts: the first creates the row (rowCount 1),
    // the second loses the optimistic conflict (rowCount 0) — only ONE unresolved
    // alert is ever persisted for (esim, type).
    mockPrisma.$executeRawUnsafe.mockResolvedValueOnce(1 as any).mockResolvedValueOnce(0 as any)
    const first = await telnaGenerateAlerts()
    expect(first.alertCount).toBe(1)
    const sql = String(inserts()[0][0])
    expect(sql).toContain('ON CONFLICT ("esimId","alertType") WHERE "acknowledgedAt" IS NULL')
    expect(sql).toContain('DO NOTHING')

    const second = await telnaGenerateAlerts()
    expect(second.alertCount).toBe(0)
    expect(inserts()).toHaveLength(2) // both attempted
    expect(inserts().filter(([, , type]) => type === 'NO_ACTIVITY')).toHaveLength(2)
    // The database partial unique index enforces the single-row guarantee — see
    // prisma/migrations/*_add_usage_alerts_dedup/migration.sql.
  })

  it('emits the catalog event only for newly created alerts', async () => {
    const result = await telnaGenerateAlerts()
    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(result.alertCount).toBe(1)
  })

  it('never queries or alerts terminal eSIMs (REFUNDED/FAILED/EXPIRED/CANCELLED are skipped)', async () => {
    mockPrisma.eSIM.findMany.mockResolvedValue([])
    await telnaGenerateAlerts()
    const selection = mockPrisma.eSIM.findMany.mock.calls[0][0]
    expect(selection.where.status.notIn).toEqual(TERMINAL)

    // A terminal row provided to the generator produces no usage queries and no alerts.
    mockPrisma.eSIM.findMany.mockResolvedValue([{ ...esimRow(), status: 'REFUNDED' }])
    vi.clearAllMocks()
    mockPrisma.eSIM.findMany.mockResolvedValue([{ ...esimRow(), status: 'REFUNDED' }])
    mockPrisma.usageRecord.findMany.mockResolvedValue([])
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1 as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await telnaGenerateAlerts()
    expect(result.alertCount).toBe(0)
    expect(mockPrisma.usageRecord.findMany).not.toHaveBeenCalled()
  })

  it('authoritative replenishment (pct < 80) resolves obsolete USAGE_80/90/100 alerts', async () => {
    mockPrisma.usageRecord.findMany.mockResolvedValue([{ id: 'u1', dataUsedMB: 10, dataTotalMB: 500, dataRemainingMB: 450, timestamp: new Date() }])
    mockPrisma.eSIM.findMany.mockResolvedValue([esimRow()])
    const result = await telnaGenerateAlerts()
    expect(result.alertCount).toBe(0)
    const resolveTypes = updates().map(c => c[2])
    expect(resolveTypes).toEqual(expect.arrayContaining(['USAGE_80', 'USAGE_90', 'USAGE_100']))
  })

  it('threshold progression: creating USAGE_100 resolves the lower USAGE_80/USAGE_90 tiers', async () => {
    mockPrisma.usageRecord.findMany.mockResolvedValue([{ id: 'u1', dataUsedMB: 500, dataTotalMB: 500, dataRemainingMB: 0, timestamp: new Date() }])
    mockPrisma.eSIM.findMany.mockResolvedValue([esimRow()])
    const result = await telnaGenerateAlerts()
    expect(result.alertCount).toBe(1)
    expect(inserts()[0][2]).toBe('USAGE_100')
    const resolveTypes = updates().map(c => c[2])
    expect(resolveTypes).toContain('USAGE_80')
    expect(resolveTypes).toContain('USAGE_90')
  })

  it('activity resuming resolves the unresolved NO_ACTIVITY alert', async () => {
    mockPrisma.usageRecord.findMany.mockResolvedValue([{ id: 'u1', dataUsedMB: 5, dataTotalMB: 500, dataRemainingMB: 495, timestamp: new Date() }])
    mockPrisma.eSIM.findMany.mockResolvedValue([esimRow()])
    const result = await telnaGenerateAlerts()
    expect(result.alertCount).toBe(0)
    const resolveTypes = updates().map(c => c[2])
    expect(resolveTypes).toContain('NO_ACTIVITY')
  })
})
