import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    eSIM: { findUnique: vi.fn(), update: vi.fn() },
    usageRecord: { create: vi.fn(), findMany: vi.fn() },
    usageSession: { create: vi.fn(), count: vi.fn() },
    usageAlert: { count: vi.fn(), create: vi.fn() },
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
const { telnaSyncUsage, telnaSyncSessions, telnaSyncBalances } = await import('./telna-usage-analytics')

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
