import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { claimProviderIccid, releaseProviderIccidClaim } from './esim-inventory-claim'

const mockPrisma = vi.mocked(prisma)

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.eSIM.create.mockResolvedValue({} as any)
  mockPrisma.eSIM.findUnique.mockResolvedValue(null)
  mockPrisma.eSIM.delete.mockResolvedValue({} as any)
})

describe('claimProviderIccid (atomic, provider-neutral)', () => {
  it('inserts a PROCESSING eSIM claim keyed by the unique iccid + purchaseId', async () => {
    const r = await claimProviderIccid({ purchaseId: 'order-1', iccid: 'PROV-ICCID' })
    expect(r.ok).toBe(true)
    expect(mockPrisma.eSIM.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ purchaseId: 'order-1', iccid: 'PROV-ICCID', status: 'PROCESSING', providerActivationId: '' }),
    }))
  })

  it('P2002 unique conflict → ok:false (claim lost, try next candidate)', async () => {
    mockPrisma.eSIM.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    const r = await claimProviderIccid({ purchaseId: 'order-1', iccid: 'TAKEN' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('CLAIM_LOST')
  })

  it('missing purchaseId is rejected before any DB call', async () => {
    const r = await claimProviderIccid({ purchaseId: '', iccid: 'X' })
    expect(r.ok).toBe(false)
    expect(mockPrisma.eSIM.create).not.toHaveBeenCalled()
  })

  it('non-unique DB errors propagate (never fabricate a claim)', async () => {
    mockPrisma.eSIM.create.mockRejectedValueOnce(new Error('connection refused'))
    await expect(claimProviderIccid({ purchaseId: 'order-1', iccid: 'X' })).rejects.toThrow()
  })
})

describe('releaseProviderIccidClaim (ownership-safe)', () => {
  it('deletes only the unfinalized PROCESSING claim owned by this purchase', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue({ id: 'c1', purchaseId: 'order-1', status: 'PROCESSING', providerActivationId: '', activatedAt: null } as any)
    await releaseProviderIccidClaim({ purchaseId: 'order-1', iccid: 'PROV-ICCID' })
    expect(mockPrisma.eSIM.delete).toHaveBeenCalledWith({ where: { id: 'c1' } })
  })

  it('never deletes a claim owned by ANOTHER purchase', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue({ id: 'c-other', purchaseId: 'OTHER-ORDER', status: 'PROCESSING', providerActivationId: '', activatedAt: null } as any)
    await releaseProviderIccidClaim({ purchaseId: 'order-1', iccid: 'PROV-ICCID' })
    expect(mockPrisma.eSIM.delete).not.toHaveBeenCalled()
  })

  it('never deletes a FINALIZED eSIM (has providerActivationId)', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue({ id: 'finalized', purchaseId: 'order-1', status: 'ACTIVE', providerActivationId: 'pkg-9', activatedAt: new Date() } as any)
    await releaseProviderIccidClaim({ purchaseId: 'order-1', iccid: 'PROV-ICCID' })
    expect(mockPrisma.eSIM.delete).not.toHaveBeenCalled()
  })

  it('never deletes a row that is no longer a PROCESSING claim', async () => {
    mockPrisma.eSIM.findUnique.mockResolvedValue({ id: 'committed', purchaseId: 'order-1', status: 'PENDING_ACTIVATION', providerActivationId: 'pkg-1', activatedAt: null } as any)
    await releaseProviderIccidClaim({ purchaseId: 'order-1', iccid: 'PROV-ICCID' })
    expect(mockPrisma.eSIM.delete).not.toHaveBeenCalled()
  })

  it('missing purchaseId is a no-op', async () => {
    await releaseProviderIccidClaim({ purchaseId: '', iccid: 'X' })
    expect(mockPrisma.eSIM.findUnique).not.toHaveBeenCalled()
  })
})
