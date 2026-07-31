import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn() },
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

vi.mock('@/lib/catalog-events', () => ({
  emitEvent: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { emitEvent } from '@/lib/catalog-events'
import { syncSubscriptionStatus } from './ibasis-subscription-sync'

const mockPrisma = vi.mocked(prisma)
const mockSession = vi.mocked(getServerSession)
const mockBuild = vi.mocked(buildConnectorFromProvider)
const mockEmit = vi.mocked(emitEvent)

const PROVIDER = { id: 'ibasis-1', code: 'IBASIS', name: 'iBASIS' }

function adminSession() {
  mockSession.mockResolvedValue({ user: { id: 'admin-1', role: 'INTERNAL_ADMIN' } } as any)
}

function makeLocalEsim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esim-1',
    iccid: '89975111967191511974',
    status: 'PENDING',
    providerSubscriptionId: null,
    providerActivationId: null,
    providerSubscriberId: null,
    providerResponse: null,
    ...overrides,
  }
}

function makeFakeConnector(overrides: Record<string, unknown> = {}) {
  return {
    getSubscription: vi.fn(async () => ({
      success: true,
      data: {
        providerSubscriptionId: 'sub-1',
        subscriberId: 'sub-42',
        iccid: '89975111967191511974',
        msisdn: null,
        planId: '1GB_TEST_PLAN',
        status: 'ACTIVE',
        providerStatus: 'active',
        rawData: {
          id: 'sub-1',
          status: 'active',
          subscriber: 'sub-42',
          devices: [{ device: '89975111967191511974', type: 'iccid' }],
          plan: '1GB_TEST_PLAN',
        },
      },
    })),
    getActivationStatus: vi.fn(async () => ({
      success: true,
      data: { activationId: 'act-1', status: 'PENDING', providerStatus: 'pending', providerSubscriptionId: null },
    })),
    ...overrides,
  }
}

describe('syncSubscriptionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(PROVIDER as any)
    mockPrisma.eSIM.update.mockResolvedValue({} as any)
  })

  it('throws when not an internal admin', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1', role: 'CUSTOMER' } } as any)
    await expect(syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-1' })).rejects.toThrow('Unauthorized')
  })

  it('returns an error when provider is not found', async () => {
    adminSession()
    mockPrisma.provider.findUnique.mockResolvedValue(null)
    const res = await syncSubscriptionStatus({ providerId: 'missing', providerSubscriptionId: 'sub-1' })
    expect(res).toEqual({ error: 'Provider not found' })
  })

  it('returns an error when the provider has no iBASIS connector', async () => {
    adminSession()
    mockBuild.mockResolvedValue({} as any)
    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-1' })
    expect(res.error).toContain('does not support iBASIS subscription sync')
  })

  it('fetches provider state and updates the local ESIM with linkage + status', async () => {
    adminSession()
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(makeLocalEsim())

    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-1' })

    expect(connector.getSubscription).toHaveBeenCalledWith('sub-1')
    expect(res.success).toBe(true)
    expect(res.status).toBe('SYNCED')
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith({
      where: { id: 'esim-1' },
      data: expect.objectContaining({
        status: 'ACTIVE',
        providerStatus: 'active',
        lastStatusSyncAt: expect.any(Date),
        providerSubscriptionId: 'sub-1',
        providerSubscriberId: 'sub-42',
        providerResponse: expect.objectContaining({ __syncSig: 'ACTIVE', __statusHistory: [{ from: 'PENDING', to: 'ACTIVE', providerStatus: 'active', at: expect.any(String) }] }),
      }),
    })
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SIM_STATUS_CHANGED' }))
  })

  it('keeps an existing providerSubscriptionId untouched', async () => {
    adminSession()
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(makeLocalEsim({ providerSubscriptionId: 'sub-existing' }))

    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-existing' })

    expect(res.success).toBe(true)
    expect(mockPrisma.eSIM.update).toHaveBeenCalledWith({
      where: { id: 'esim-1' },
      data: expect.not.objectContaining({ providerSubscriptionId: expect.anything() }),
    })
  })

  it('returns NO_LOCAL_RECORD without persisting when no local ESIM matches', async () => {
    adminSession()
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(null)

    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-1' })

    expect(res.success).toBe(true)
    expect(res.status).toBe('NO_LOCAL_RECORD')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('blocks terminal regression EXPIRED → ACTIVE', async () => {
    adminSession()
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(makeLocalEsim({ status: 'EXPIRED', providerSubscriptionId: 'sub-1' }))

    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-1' })

    expect(res.success).toBe(true)
    expect(res.skipped).toBe(true)
    expect(res.reason).toContain('Blocked status regression')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('allows terminal regression when force is set', async () => {
    adminSession()
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(makeLocalEsim({ status: 'CANCELLED', providerSubscriptionId: 'sub-1' }))

    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-1', force: true })

    expect(res.success).toBe(true)
    expect(res.skipped).toBeUndefined()
    expect(mockPrisma.eSIM.update).toHaveBeenCalled()
  })

  it('polls via activation id and upgrades to the full subscription detail once complete', async () => {
    adminSession()
    const getActivationStatus = vi.fn(async () => ({
      success: true,
      data: { activationId: 'act-1', status: 'READY_TO_INSTALL', providerStatus: 'completed', providerSubscriptionId: 'sub-9' },
    }))
    const getSubscription = vi.fn(async () => ({
      success: true,
      data: {
        providerSubscriptionId: 'sub-9',
        subscriberId: 'sub-42',
        iccid: '89975111967191511974',
        msisdn: null,
        planId: '1GB_TEST_PLAN',
        status: 'ACTIVE',
        providerStatus: 'active',
        rawData: { id: 'sub-9', status: 'active' },
      },
    }))
    const connector = makeFakeConnector({ getActivationStatus, getSubscription })
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(makeLocalEsim({ providerActivationId: 'act-1' }))

    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerActivationId: 'act-1' })

    expect(connector.getActivationStatus).toHaveBeenCalledWith('act-1')
    expect(connector.getSubscription).toHaveBeenCalledWith('sub-9')
    expect(res.success).toBe(true)
    const updateArg = mockPrisma.eSIM.update.mock.calls[0][0] as { data: any }
    expect(updateArg.data.status).toBe('ACTIVE')
    // Newly discovered subscription id is linked…
    expect(updateArg.data.providerSubscriptionId).toBe('sub-9')
    // …while the existing activation id is preserved, never overwritten.
    expect(updateArg.data.providerActivationId).toBeUndefined()
  })

  it('sanitizes PIN/PUK and activation codes from persisted metadata', async () => {
    adminSession()
    const connector = makeFakeConnector({
      getSubscription: vi.fn(async () => ({
        success: true,
        data: {
          providerSubscriptionId: 'sub-1',
          subscriberId: null,
          iccid: '89975111967191511974',
          msisdn: null,
          planId: null,
          status: 'ACTIVE',
          providerStatus: 'active',
          rawData: {
            id: 'sub-1',
            status: 'active',
            pin1: '1234',
            puk1: '11112222',
            activation_code: 'FKE: 0$CUST-SECRET.GDSB.NET$555',
            devices: [{ device: '89975111967191511974', type: 'iccid' }],
          },
        },
      })),
    })
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(makeLocalEsim({ providerSubscriptionId: 'sub-1' }))

    await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-1' })

    const updateArg = mockPrisma.eSIM.update.mock.calls[0][0] as { data: { providerResponse: any } }
    expect(updateArg.data.providerResponse.pin1).toBeUndefined()
    expect(updateArg.data.providerResponse.puk1).toBeUndefined()
    expect(updateArg.data.providerResponse.activation_code).toBeUndefined()
  })

  it('returns an error when the provider fetch fails', async () => {
    adminSession()
    const connector = makeFakeConnector({
      getSubscription: vi.fn(async () => ({ success: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } })),
    })
    mockBuild.mockResolvedValue(connector as any)

    const res = await syncSubscriptionStatus({ providerId: 'ibasis-1', providerSubscriptionId: 'sub-missing' })
    expect(res.error).toContain('subscription not found')
    expect(mockPrisma.eSIM.findFirst).not.toHaveBeenCalled()
  })
})
