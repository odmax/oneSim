import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn() },
    providerPackage: { findFirst: vi.fn() },
  },
}))

vi.mock('@/lib/providers/adapter-manager', () => ({
  getAdapterForType: vi.fn(),
  isProviderOperational: vi.fn((status: string) => ['ACTIVE', 'DEGRADED', 'TESTING'].includes(status)),
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  resolveConnectorType: vi.fn(() => 'CUSTOM'),
}))

import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { testProviderPurchase } from './provider-test-purchase'

const mockSession = vi.mocked(getServerSession)
const mockPrisma = vi.mocked(prisma)
const mockAdapter = vi.mocked(getAdapterForType)

const PROVIDER = { id: 'prov-1', name: 'AirHub', type: 'CUSTOM', status: 'ACTIVE', adapterStrategy: 'CUSTOM', code: 'AIRHUB' }
const PACKAGE_BASE = { id: 'pp-1', providerId: 'prov-1', providerPlanId: 'US-5GB-30D', providerPlanCode: 'US-5GB-30D', name: 'US 5GB' }
const ACTIVATE_RESULT = {
  success: true,
  data: { activationId: 'act-1', iccids: ['89012345678901234567'], qrCodeUrl: 'https://qr', status: 'PENDING_ACTIVATION' },
}

function setupAdapter(overrides: Partial<ReturnType<typeof vi.fn>> = {}) {
  mockAdapter.mockResolvedValue({
    validatePurchase: vi.fn().mockResolvedValue({ valid: true }),
    activateESIM: vi.fn().mockResolvedValue(ACTIVATE_RESULT),
    ...overrides,
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue({ user: { id: 'u1', role: 'INTERNAL_ADMIN' } } as any)
  mockPrisma.provider.findUnique.mockResolvedValue(PROVIDER as any)
})

describe('testProviderPurchase travel-date handling', () => {
  it('fails fast before any dispatch when a required travel date is missing', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue({
      ...PACKAGE_BASE,
      providerRawData: { planCode: 'US-5GB-30D', __requiresTravelDate: true },
    } as any)
    const activateESIM = vi.fn().mockResolvedValue(ACTIVATE_RESULT)
    setupAdapter({ activateESIM })

    const result = await testProviderPurchase('prov-1', 'pp-1', 1)

    expect(result.success).toBe(false)
    expect(result.errorStep).toBe('travel_date')
    expect(result.error).toMatch(/requires a Travel Date/)
    expect(activateESIM).not.toHaveBeenCalled()
  })

  it('rejects an invalid travel date format before any dispatch', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue({
      ...PACKAGE_BASE,
      providerRawData: { planCode: 'US-5GB-30D', __requiresTravelDate: true },
    } as any)
    const activateESIM = vi.fn().mockResolvedValue(ACTIVATE_RESULT)
    setupAdapter({ activateESIM })

    const result = await testProviderPurchase('prov-1', 'pp-1', 1, '08/02/2026')

    expect(result.success).toBe(false)
    expect(result.errorStep).toBe('travel_date')
    expect(result.error).toMatch(/YYYY-MM-DD/)
    expect(activateESIM).not.toHaveBeenCalled()
  })

  it('passes a valid travel date through when the plan requires it', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue({
      ...PACKAGE_BASE,
      providerRawData: { planCode: 'US-5GB-30D', isTravelDateRequired: 'Mandatory' },
    } as any)
    const activateESIM = vi.fn().mockResolvedValue(ACTIVATE_RESULT)
    setupAdapter({ activateESIM })

    const result = await testProviderPurchase('prov-1', 'pp-1', 1, '2026-08-02')

    expect(result.success).toBe(true)
    expect(activateESIM).toHaveBeenCalledTimes(1)
    expect(activateESIM.mock.calls[0][0].travelDate).toBe('2026-08-02')
  })

  it('does not require a travel date for optional plans and omits it when absent', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue({
      ...PACKAGE_BASE,
      providerRawData: { planCode: 'UK-3GB-7D', __requiresTravelDate: false },
    } as any)
    const activateESIM = vi.fn().mockResolvedValue(ACTIVATE_RESULT)
    setupAdapter({ activateESIM })

    const result = await testProviderPurchase('prov-1', 'pp-1', 1)

    expect(result.success).toBe(true)
    expect(activateESIM).toHaveBeenCalledTimes(1)
    expect(activateESIM.mock.calls[0][0].travelDate).toBeUndefined()
  })

  it('still forwards an optional travel date when provided', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue({
      ...PACKAGE_BASE,
      providerRawData: { planCode: 'UK-3GB-7D' },
    } as any)
    const activateESIM = vi.fn().mockResolvedValue(ACTIVATE_RESULT)
    setupAdapter({ activateESIM })

    const result = await testProviderPurchase('prov-1', 'pp-1', 1, '2026-09-15')

    expect(result.success).toBe(true)
    expect(activateESIM.mock.calls[0][0].travelDate).toBe('2026-09-15')
  })
})
