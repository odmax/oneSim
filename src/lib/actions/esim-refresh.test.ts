import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sync: vi.fn(), session: vi.fn(), owned: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: { eSIM: { findFirst: mocks.owned } } }))
vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(url) } }))
vi.mock('@/lib/email/send-email', () => ({ sendEmail: vi.fn() }))
vi.mock('@/lib/services/esims/sync-esim-status', () => ({ syncESIMStatus: mocks.sync }))
vi.mock('@/lib/providers/capabilities/exposure', () => ({ isCapabilityExposedToPortal: vi.fn().mockResolvedValue(true) }))

import { syncEsimStatusAction } from './esim'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ user: { role: 'BUSINESS_USER', businessId: 'business-1' } })
  mocks.owned.mockResolvedValue({ purchase: { package: { providerId: 'provider-1' } } })
})

describe('Inventory manual status refresh feedback', () => {
  it.each(['STATUS_CAPABILITY_NOT_SUPPORTED', 'MISSING_PROVIDER_IDENTIFIER'])('never reports refreshed when skipped: %s', async (skipReason) => {
    mocks.sync.mockResolvedValue({ success: true, skipped: true, skipReason })
    await expect(syncEsimStatusAction('esim-1')).rejects.toThrow('/business/esims?error=')
  })
  it('reports a completed status lookup', async () => {
    mocks.sync.mockResolvedValue({ success: true, status: 'PENDING_ACTIVATION' })
    await expect(syncEsimStatusAction('esim-1')).rejects.toThrow('/business/esims?success=refreshed')
  })
  it('does not synchronize another business’s eSIM', async () => {
    mocks.owned.mockResolvedValue(null)
    await expect(syncEsimStatusAction('esim-1')).rejects.toThrow('/business/esims?error=permission')
    expect(mocks.sync).not.toHaveBeenCalled()
  })
})
