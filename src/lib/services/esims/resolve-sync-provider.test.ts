import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolvePackageBacking: vi.fn(),
}))

vi.mock('@/lib/services/orders/package-backing-resolver', () => ({
  resolvePackageBacking: mocks.resolvePackageBacking,
}))

import { resolveSyncProviderId, resolveSyncPackageIdentity } from './resolve-sync-provider'

const pkg = {
  id: 'retail-package-1',
  providerId: 'retail-default-provider',
  providerPackageId: 'bound-provider-package-1',
  providerPlanId: 'plan-1',
}

describe('resolveSyncProviderId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers the actual fulfilling purchase provider', async () => {
    const result = await resolveSyncProviderId({
      providerId: 'actual-fulfilling-provider',
      package: pkg,
    })

    expect(result).toBe('actual-fulfilling-provider')
    expect(mocks.resolvePackageBacking).not.toHaveBeenCalled()
  })

  it('resolves an authoritative bound provider for a legacy purchase', async () => {
    mocks.resolvePackageBacking.mockResolvedValue({
      kind: 'BOUND',
      backing: {
        providerId: 'authoritative-provider',
        providerPackageId: 'bound-provider-package-1',
        providerPlanId: 'plan-1',
      },
    })

    const result = await resolveSyncProviderId({
      providerId: null,
      package: pkg,
    })

    expect(result).toBe('authoritative-provider')
    expect(mocks.resolvePackageBacking).toHaveBeenCalledWith(pkg)
  })

  it.each([
    ['CUSTOM', { kind: 'CUSTOM', backings: [] }],
    ['NONE', { kind: 'NONE' }],
    ['UNAVAILABLE', { kind: 'UNAVAILABLE' }],
  ])('fails closed for %s backing', async (_kind, resolution) => {
    mocks.resolvePackageBacking.mockResolvedValue(resolution)

    const result = await resolveSyncProviderId({
      providerId: null,
      package: pkg,
    })

    expect(result).toBeNull()
  })

  it('does not use the retail provider as an unverified fallback', async () => {
    mocks.resolvePackageBacking.mockResolvedValue({ kind: 'NONE' })

    const result = await resolveSyncProviderId({
      package: pkg,
    })

    expect(result).toBeNull()
  })

  it('fails closed when purchase information is missing', async () => {
    expect(await resolveSyncProviderId(null)).toBeNull()
    expect(await resolveSyncProviderId(undefined)).toBeNull()
    expect(await resolveSyncProviderId({ providerId: null })).toBeNull()

    expect(mocks.resolvePackageBacking).not.toHaveBeenCalled()
  })
})


describe('resolveSyncPackageIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns identifiers for verified matching fulfillment provider', async () => {
    mocks.resolvePackageBacking.mockResolvedValue({
      kind: 'BOUND',
      backing: {
        providerId: 'fulfillment-provider',
        providerPackageId: 'provider-package-123',
        providerPlanId: 'provider-plan-456',
      },
    })

    const result = await resolveSyncPackageIdentity(
      { providerId: 'fulfillment-provider', package: pkg },
      'fulfillment-provider',
    )

    expect(result).toEqual({
      providerPackageId: 'provider-package-123',
      providerPlanId: 'provider-plan-456',
    })
    expect(mocks.resolvePackageBacking).toHaveBeenCalledWith(pkg)
  })

  it('does not leak retail package identifiers to another fulfillment provider', async () => {
    mocks.resolvePackageBacking.mockResolvedValue({
      kind: 'BOUND',
      backing: {
        providerId: 'retail-provider',
        providerPackageId: 'retail-package-123',
        providerPlanId: 'retail-plan-456',
      },
    })

    const result = await resolveSyncPackageIdentity(
      { providerId: 'actual-fulfillment-provider', package: pkg },
      'actual-fulfillment-provider',
    )

    expect(result).toEqual({})
  })

  it.each([
    ['CUSTOM', { kind: 'CUSTOM', backings: [] }],
    ['NONE', { kind: 'NONE' }],
    ['UNAVAILABLE', { kind: 'UNAVAILABLE' }],
  ])('fails closed for %s backing', async (_kind, backing) => {
    mocks.resolvePackageBacking.mockResolvedValue(backing)

    expect(
      await resolveSyncPackageIdentity(
        { providerId: 'actual-provider', package: pkg },
        'actual-provider',
      ),
    ).toEqual({})
  })

  it('fails closed without a valid package or provider identity', async () => {
    expect(await resolveSyncPackageIdentity(null, 'provider-1')).toEqual({})
    expect(
      await resolveSyncPackageIdentity(
        { providerId: 'provider-1' },
        'provider-1',
      ),
    ).toEqual({})
    expect(
      await resolveSyncPackageIdentity(
        { providerId: 'provider-1', package: pkg },
        '',
      ),
    ).toEqual({})

    expect(mocks.resolvePackageBacking).not.toHaveBeenCalled()
  })

  it('fails closed when the backing provider differs from the legacy resolved provider', async () => {
    mocks.resolvePackageBacking.mockResolvedValue({
      kind: 'BOUND',
      backing: {
        providerId: 'provider-a',
        providerPackageId: 'package-a',
        providerPlanId: 'plan-a',
      },
    })

    expect(
      await resolveSyncPackageIdentity(
        { providerId: null, package: pkg },
        'provider-b',
      ),
    ).toEqual({})
  })
})
