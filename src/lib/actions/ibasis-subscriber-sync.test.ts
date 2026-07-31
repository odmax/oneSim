import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn() },
    customer: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { ensureIbasisSubscriber, getIbasisSubscriber, updateIbasisSubscriber } from './ibasis-subscriber-sync'

const mockPrisma = vi.mocked(prisma)
const mockSession = vi.mocked(getServerSession)
const mockBuild = vi.mocked(buildConnectorFromProvider)

const PROVIDER = { id: 'ibasis-1', code: 'IBASIS', name: 'iBASIS' }

function adminSession() {
  mockSession.mockResolvedValue({ user: { id: 'admin-1', role: 'INTERNAL_ADMIN' } } as any)
}

function makeFakeConnector(overrides: Record<string, unknown> = {}) {
  return {
    searchSubscribers: vi.fn(async () => ({ success: true, data: { items: [], total: 0, next: null, previous: null } })),
    createSubscriber: vi.fn(async () => ({ success: true, data: { providerSubscriberId: 'sub-42' } })),
    getSubscriber: vi.fn(async () => ({
      success: true,
      data: {
        providerSubscriberId: 'sub-42',
        username: 'jane.doe',
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        phone: '+15551234567',
        rawData: { id: 'sub-42', username: 'jane.doe', email: 'jane@example.com' },
      },
    })),
    updateSubscriber: vi.fn(async () => ({
      success: true,
      data: {
        providerSubscriberId: 'sub-42',
        username: 'jane.doe',
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'new@example.com',
        phone: null,
        rawData: { id: 'sub-42', username: 'jane.doe', email: 'new@example.com' },
      },
    })),
    ...overrides,
  }
}

describe('ensureIbasisSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(PROVIDER as any)
  })

  it('throws when not an internal admin', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1', role: 'CUSTOMER' } } as any)
    await expect(ensureIbasisSubscriber('ibasis-1', 'biz-1', { username: 'jane.doe' })).rejects.toThrow('Unauthorized')
  })

  it('returns an error when provider is not found', async () => {
    adminSession()
    mockPrisma.provider.findUnique.mockResolvedValue(null)
    const res = await ensureIbasisSubscriber('missing', 'biz-1', { username: 'jane.doe' })
    expect(res).toEqual({ error: 'Provider not found' })
  })

  it('returns an error when the provider has no iBASIS connector', async () => {
    adminSession()
    mockBuild.mockResolvedValue({} as any)
    const res = await ensureIbasisSubscriber('ibasis-1', 'biz-1', { username: 'jane.doe' })
    expect(res.error).toContain('does not support iBASIS subscriber sync')
  })

  it('creates a new provider subscriber then a local customer', async () => {
    adminSession()
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.customer.findFirst.mockResolvedValue(null)
    mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)

    const res = await ensureIbasisSubscriber('ibasis-1', 'biz-1', { username: 'jane.doe' })

    expect(res.success).toBe(true)
    expect(connector.searchSubscribers).toHaveBeenCalled()
    expect(connector.createSubscriber).toHaveBeenCalledWith({ username: 'jane.doe' })
    expect(connector.getSubscriber).toHaveBeenCalledWith('sub-42')
    expect(mockPrisma.customer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessId: 'biz-1',
        providerSubscriberId: 'sub-42',
        name: 'Jane Doe',
        email: 'jane@example.com',
        country: 'XX',
      }),
    })
    expect(res.result).toMatchObject({ providerSubscriberId: 'sub-42', customerId: 'cust-1' })
  })

  it('never creates a duplicate — reuses an existing provider subscriber', async () => {
    adminSession()
    const connector = makeFakeConnector({
      searchSubscribers: vi.fn(async () => ({ success: true, data: { items: ['sub-42'], total: 1, next: null, previous: null } })),
    })
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.customer.findFirst.mockResolvedValue(null)
    mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)

    const res = await ensureIbasisSubscriber('ibasis-1', 'biz-1', { username: 'jane.doe' })

    expect(connector.createSubscriber).not.toHaveBeenCalled()
    expect(res.success).toBe(true)
  })

  it('refreshes providerMetadata on an existing customer without overwriting business data', async () => {
    adminSession()
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'cust-1', name: 'Original Name' } as any)
    mockPrisma.customer.update.mockResolvedValue({ id: 'cust-1' } as any)

    const res = await ensureIbasisSubscriber('ibasis-1', 'biz-1', { username: 'jane.doe' })

    expect(mockPrisma.customer.create).not.toHaveBeenCalled()
    expect(mockPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust-1' },
      data: expect.objectContaining({ providerMetadata: expect.anything() }),
    })
    expect(res.result?.customerId).toBe('cust-1')
  })

  it('returns an error when the provider search fails', async () => {
    adminSession()
    const connector = makeFakeConnector({
      searchSubscribers: vi.fn(async () => ({ success: false, error: { code: 'AUTH_ERROR', message: 'iBASIS authentication failed (HTTP 401)' } })),
    })
    mockBuild.mockResolvedValue(connector as any)

    const res = await ensureIbasisSubscriber('ibasis-1', 'biz-1', { username: 'jane.doe' })

    expect(res.success).toBeUndefined()
    expect(res.error).toContain('Failed to search subscribers')
  })
})

describe('getIbasisSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(PROVIDER as any)
    adminSession()
  })

  it('returns an error when the subscriber is missing on the provider', async () => {
    const connector = makeFakeConnector({
      getSubscriber: vi.fn(async () => ({ success: false, error: { code: 'NOT_FOUND', message: 'not found' } })),
    })
    mockBuild.mockResolvedValue(connector as any)

    const res = await getIbasisSubscriber('ibasis-1', 'biz-1', 'missing')
    expect(res.error).toContain('not found')
  })

  it('mirrors linkage fields back onto the local customer', async () => {
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.customer.findFirst.mockResolvedValue(null)
    mockPrisma.customer.create.mockResolvedValue({ id: 'cust-1' } as any)

    const res = await getIbasisSubscriber('ibasis-1', 'biz-1', 'sub-42')
    expect(res.success).toBe(true)
    expect(res.result).toMatchObject({ providerSubscriberId: 'sub-42', firstName: 'Jane' })
  })
})

describe('updateIbasisSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(PROVIDER as any)
    adminSession()
  })

  it('calls the connector update and mirrors back to the local customer', async () => {
    const connector = makeFakeConnector()
    mockBuild.mockResolvedValue(connector as any)
    mockPrisma.customer.findFirst.mockResolvedValue({ id: 'cust-1' } as any)
    mockPrisma.customer.update.mockResolvedValue({ id: 'cust-1' } as any)

    const res = await updateIbasisSubscriber('ibasis-1', 'biz-1', 'sub-42', { username: 'jane.doe', email: 'new@example.com' })
    expect(connector.updateSubscriber).toHaveBeenCalledWith('sub-42', { username: 'jane.doe', email: 'new@example.com' })
    expect(res.success).toBe(true)
    expect(res.result).toEqual({ providerSubscriberId: 'sub-42', customerId: 'cust-1', updated: true })
  })

  it('returns an error when the provider update fails', async () => {
    const connector = makeFakeConnector({
      updateSubscriber: vi.fn(async () => ({ success: false, error: { code: 'VALIDATION_ERROR', message: 'invalid email' } })),
    })
    mockBuild.mockResolvedValue(connector as any)

    const res = await updateIbasisSubscriber('ibasis-1', 'biz-1', 'sub-42', { username: 'jane.doe' })
    expect(res.error).toContain('invalid email')
  })
})
