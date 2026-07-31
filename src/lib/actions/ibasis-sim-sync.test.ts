import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { emitEvent } from '@/lib/catalog-events'
import { ibasisSyncSims } from './ibasis-sim-sync'

const mockPrisma = vi.mocked(prisma)
const mockSession = vi.mocked(getServerSession)
const mockBuild = vi.mocked(buildConnectorFromProvider)
const mockStart = vi.mocked(startPipelineRun)
const mockRecordStage = vi.mocked(recordStageFromCounts)
const mockComplete = vi.mocked(completePipelineRun)
const mockFail = vi.mocked(failPipelineRun)
const mockEmit = vi.mocked(emitEvent)

const PROVIDER = { id: 'ibasis-1', code: 'IBASIS', name: 'iBASIS' }

function makeFakeConnector(pages: Array<{ items: any[]; total: number; next: string | null }>) {
  return {
    listInventorySims: vi.fn(async (query?: { nextUrl?: string }) => {
      const index = pages.findIndex((p, i) => (i === 0 ? !query?.nextUrl : query?.nextUrl === `next-${i}`))
      if (index === -1) return { success: false, error: { code: 'UNKNOWN_PAGE', message: 'unknown page' } }
      return { success: true, data: pages[index] }
    }),
  }
}

function adminSession() {
  mockSession.mockResolvedValue({ user: { id: 'admin-1', role: 'INTERNAL_ADMIN' } } as any)
}

describe('ibasisSyncSims', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(PROVIDER as any)
    mockPrisma.provider.update.mockResolvedValue({} as any)
    mockPrisma.eSIM.update.mockResolvedValue({} as any)
  })

  it('throws when not an internal admin', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1', role: 'CUSTOMER' } } as any)
    await expect(ibasisSyncSims('ibasis-1')).rejects.toThrow('Unauthorized')
    expect(mockPrisma.provider.findUnique).not.toHaveBeenCalled()
  })

  it('returns an error when provider is not found', async () => {
    adminSession()
    mockPrisma.provider.findUnique.mockResolvedValue(null)
    const res = await ibasisSyncSims('missing')
    expect(res).toEqual({ error: 'Provider not found' })
  })

  it('returns an error when provider has no iBASIS connector', async () => {
    adminSession()
    mockBuild.mockResolvedValue({} as any)
    const res = await ibasisSyncSims('ibasis-1')
    expect(res.error).toContain('does not support iBASIS SIM sync')
  })

  it('updates matching ESIMs by ICCID and records the pipeline', async () => {
    adminSession()
    const connector = makeFakeConnector([
      {
        total: 1,
        next: null,
        items: [{ iccid: '89975111967191511974', type: 'esim', carrier: 'AT&T', status: 'Inventory', activation_code: 'FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555' }],
      },
    ])
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue({ id: 'esim-1', iccid: '89975111967191511974', status: 'ACTIVE', providerResponse: null })

    const res = await ibasisSyncSims('ibasis-1')

    expect(res.success).toBe(true)
    expect(res.result).toMatchObject({ fetched: 1, created: 0, updated: 1, skipped: 0 })
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith({
      where: { id: 'esim-1' },
      data: expect.objectContaining({
        status: 'NOT_SENT',
        providerStatus: 'Inventory',
        activationCode: 'FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555',
        lastSyncAt: expect.any(Date),
      }),
    })
    expect(mockStart).toHaveBeenCalled()
    expect(mockRecordStage).toHaveBeenCalled()
    expect(mockComplete).toHaveBeenCalledWith('run-1', 'SUCCESS', 1)
    expect(mockFail).not.toHaveBeenCalled()
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SIM_STATUS_CHANGED' }))
  })

  it('skips SIMs whose signature is unchanged', async () => {
    adminSession()
    const connector = makeFakeConnector([
      { total: 1, next: null, items: [{ iccid: '89975111967191511974', type: 'esim', carrier: 'AT&T', status: 'Active' }] },
    ])
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue({
      id: 'esim-1',
      iccid: '89975111967191511974',
      status: 'ACTIVE',
      providerResponse: { __syncSig: JSON.stringify({ s: 'Active', t: 'esim', c: 'AT&T', a: '' }) },
    })

    const res = await ibasisSyncSims('ibasis-1')
    expect(res.result).toMatchObject({ fetched: 1, updated: 0, skipped: 1 })
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('skips SIMs with no matching ESIM purchase', async () => {
    adminSession()
    const connector = makeFakeConnector([
      { total: 1, next: null, items: [{ iccid: '89975111967191511974', type: 'esim', carrier: 'AT&T', status: 'Inventory' }] },
    ])
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(null)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await ibasisSyncSims('ibasis-1')
    expect(res.result).toMatchObject({ fetched: 1, updated: 0, skipped: 1 })

    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      const line = String(args)
      expect(line).not.toContain('89975111967191511974')
      expect(line).not.toContain('FKE: 0$CUST')
    }
    logSpy.mockRestore()
  })

  it('walks all pagination pages via next URLs', async () => {
    adminSession()
    const pages = [
      { total: 2, next: 'next-1', items: [{ iccid: '11111111111111111111', type: 'esim', carrier: 'A', status: 'Active' }] },
      { total: 2, next: null, items: [{ iccid: '22222222222222222222', type: 'esim', carrier: 'B', status: 'Active' }] },
    ]
    const connector = makeFakeConnector(pages)
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(null)

    const res = await ibasisSyncSims('ibasis-1')
    expect(connector.listInventorySims).toHaveBeenCalledTimes(2)
    expect(res.result.fetched).toBe(2)
  })

  it('fails the pipeline when a page fetch fails', async () => {
    adminSession()
    const connector = {
      listInventorySims: vi.fn().mockResolvedValue({ success: false, error: { code: 'AUTH_ERROR', message: 'iBASIS authentication failed (HTTP 401)' } }),
    }
    mockBuild.mockResolvedValue(connector as any)

    const res = await ibasisSyncSims('ibasis-1')
    expect(res.error).toContain('Failed to list SIM inventory')
    expect(mockFail).toHaveBeenCalledWith('run-1', 'iBASIS authentication failed (HTTP 401)')
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it('fails the pipeline on an unexpected error', async () => {
    adminSession()
    mockBuild.mockRejectedValue(new Error('boom'))
    const res = await ibasisSyncSims('ibasis-1')
    expect(res.error).toContain('boom')
    expect(mockFail).toHaveBeenCalled()
  })

  it('logs only masked ICCIDs and activation codes during a successful sync', async () => {
    adminSession()
    const activationCode = 'FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555'
    const connector = makeFakeConnector([
      { total: 1, next: null, items: [{ iccid: '89975111967191511974', type: 'esim', carrier: 'AT&T', status: 'Active', activation_code: activationCode }] },
    ])
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue({ id: 'esim-1', iccid: '89975111967191511974', status: 'ACTIVE', providerResponse: null })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await ibasisSyncSims('ibasis-1')

    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      const line = String(args)
      expect(line).not.toContain('89975111967191511974')
      expect(line).not.toContain(activationCode)
    }
    logSpy.mockRestore()
  })
})
