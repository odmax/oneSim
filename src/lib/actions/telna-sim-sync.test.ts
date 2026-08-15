import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    eSIM: { findFirst: vi.fn(), update: vi.fn() },
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

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('run-1'),
  recordStageFromCounts: vi.fn().mockResolvedValue(undefined),
  completePipelineRun: vi.fn().mockResolvedValue(undefined),
  failPipelineRun: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/catalog-events', () => ({
  emitEvent: vi.fn(),
}))

const { prisma } = await import('@/lib/prisma')
const { getServerSession } = await import('next-auth')
const { buildConnectorFromProvider } = await import('@/lib/providers/connectors/connector-factory')
const { telnaSyncSims } = await import('./telna-sim-sync')

const mockPrisma = vi.mocked(prisma)
const mockSession = vi.mocked(getServerSession)
const mockBuild = vi.mocked(buildConnectorFromProvider)

const ICCID = '89012345678901234567'

function adminSession() {
  mockSession.mockResolvedValue({ user: { id: 'admin-1', role: 'INTERNAL_ADMIN' } } as any)
}

function fakeConnector() {
  return {
    listSimRegistries: vi.fn().mockResolvedValue({
      success: true,
      data: { items: [{ id: 1, iccid: ICCID, imsi: '310150123456789', msisdn: '+12025551234', status: 'ACTIVE', inventory_id: 10, group_id: 20, activation_date: '2025-01-15T00:00:00Z' }], total: 1 },
    }),
  }
}

describe('telnaSyncSims log masking', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    adminSession()
    mockPrisma.provider.findUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', name: 'Telna' } as any)
    mockPrisma.provider.update.mockResolvedValue({} as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(null) // no matching local ESIM → skip log path
    mockPrisma.eSIM.update.mockResolvedValue({})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('logs masked ICCID, never the raw ICCID', async () => {
    mockBuild.mockResolvedValue(fakeConnector() as any)
    const result = await telnaSyncSims('telna-1')
    expect(result.success).toBe(true)
    expect(logSpy).toHaveBeenCalled()
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      const line = String(args)
      expect(line).not.toContain(ICCID)
    }
    // The skip-path log carries the masked ICCID.
    expect(logSpy.mock.calls.some(([args]) => String(args).includes('[TELNA_SIM_SYNC]') && String(args).includes('8901••••4567'))).toBe(true)
  })
})
