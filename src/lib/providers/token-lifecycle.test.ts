import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma before importing token-lifecycle
vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('./connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
  getStoredCredentials: vi.fn(),
}))

vi.mock('./adapter-manager', () => ({
  buildAdapter: vi.fn(),
}))

const { getTokenState, ensureAuthenticated, withTokenRefresh } = await import('./token-lifecycle')
const { prisma } = await import('@/lib/prisma')

describe('token-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getTokenState', () => {
    it('returns missing state when provider not found', async () => {
      vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
      const state = await getTokenState('nonexistent')
      expect(state.tokenPresent).toBe(false)
      expect(state.expired).toBe(false)
    })

    it('detects present token with no expiry', async () => {
      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: {},
      } as any)
      const state = await getTokenState('p1')
      expect(state.tokenPresent).toBe(true)
      expect(state.expiryPresent).toBe(false)
      expect(state.expired).toBe(false)
    })

    it('detects expired token with numeric timestamp', async () => {
      const past = Math.floor(Date.now() / 1000) - 3600
      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: { tokenExpiry: past },
      } as any)
      const state = await getTokenState('p1')
      expect(state.expired).toBe(true)
    })

    it('detects non-expired token with future timestamp', async () => {
      const future = Math.floor(Date.now() / 1000) + 3600
      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: { tokenExpiry: future },
      } as any)
      const state = await getTokenState('p1')
      expect(state.expired).toBe(false)
      expect(state.tokenPresent).toBe(true)
    })
  })

  describe('ensureAuthenticated', () => {
    it('returns success when token is valid and not expired', async () => {
      const future = Math.floor(Date.now() / 1000) + 3600
      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: { tokenExpiry: future },
        code: 'TEST',
      } as any)
      const result = await ensureAuthenticated('p1')
      expect(result.success).toBe(true)
    })

    it('returns failure when token missing and no stored credentials', async () => {
      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: null,
        config: {},
        code: 'TEST',
      } as any)
      const mockGetStoredCredentials = (await import('./connectors/connector-factory')).getStoredCredentials
      vi.mocked(mockGetStoredCredentials).mockResolvedValue(null)

      const result = await ensureAuthenticated('p1')
      expect(result.success).toBe(false)
    })
  })

  describe('withTokenRefresh', () => {
    it('executes fn and returns data on success', async () => {
      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: {},
        code: 'TEST',
      } as any)
      const fn = vi.fn().mockResolvedValue({ success: true, data: { plans: [] } })
      const result = await withTokenRefresh('p1', 'test', fn)
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ plans: [] })
    })

    it('retries once on 401 and succeeds after refresh', async () => {
      const mockGetStoredCredentials = (await import('./connectors/connector-factory')).getStoredCredentials
      const mockBuildConnector = (await import('./connectors/connector-factory')).buildConnectorFromProvider

      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: {},
        code: 'TEST',
      } as any)

      vi.mocked(mockGetStoredCredentials).mockResolvedValue({ username: 'u', password: 'p' })
      vi.mocked(mockBuildConnector).mockResolvedValue({
        authenticate: vi.fn().mockResolvedValue({ success: true, data: { token: 'new-token' } }),
      } as any)

      let callCount = 0
      const fn = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return { success: false, status: 401, error: { code: 'HTTP_401', message: 'Unauthorized' } }
        return { success: true, data: { plans: [] } }
      })

      const result = await withTokenRefresh('p1', 'get-plans', fn)
      expect(result.success).toBe(true)
      expect(callCount).toBe(2)
    })

    it('does not loop on second 401', async () => {
      const mockGetStoredCredentials = (await import('./connectors/connector-factory')).getStoredCredentials
      const mockBuildConnector = (await import('./connectors/connector-factory')).buildConnectorFromProvider

      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: {},
        code: 'TEST',
      } as any)

      vi.mocked(mockGetStoredCredentials).mockResolvedValue({ username: 'u', password: 'p' })
      vi.mocked(mockBuildConnector).mockResolvedValue({
        authenticate: vi.fn().mockResolvedValue({ success: true, data: { token: 'new-token' } }),
      } as any)

      const fn = vi.fn().mockResolvedValue({ success: false, status: 401, error: { code: 'HTTP_401', message: 'Unauthorized' } })
      const result = await withTokenRefresh('p1', 'get-plans', fn)
      expect(result.success).toBe(false)
    })

    it('returns error when fn fails with non-401', async () => {
      vi.mocked(prisma.provider.findUnique).mockResolvedValue({
        apiToken: 'encrypted-token',
        config: {},
        code: 'TEST',
      } as any)
      const fn = vi.fn().mockResolvedValue({ success: false, status: 500, error: { code: 'HTTP_500', message: 'Server error' } })
      const result = await withTokenRefresh('p1', 'test', fn)
      expect(result.success).toBe(false)
    })
  })
})
