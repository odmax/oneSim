import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/encryption', () => ({
  encryptToken: (t: unknown) => t,
  decryptToken: (t: unknown) => t,
}))
vi.mock('@/lib/services/providers/health-monitor', () => ({
  recordHealthEvent: vi.fn(),
}))

import { createConnector } from './connector-factory'
import { capabilitySupported } from '@/lib/services/esims/sync-lookup'

/**
 * Three-provider status/usage capability matrix (manual-refresh regression).
 * Every manual Refresh Status action routes through canonical syncESIMStatus,
 * which gates per-provider by connector-declared capabilities — so the matrix
 * below is what the recurring + manual refresh actually honors. No provider-name
 * branch exists in the sync layer.
 */
describe('three-provider status/usage capability matrix', () => {
  it('USMATRIX: status + usage both supported', () => {
    const c = createConnector('p-usm', 'US-Matrix', 'USMATRIX', {})
    expect(c.capabilities?.statusLookup).toBe(true)
    expect(c.capabilities?.usageLookup).toBe(true)
    expect(capabilitySupported(c, 'statusLookup')).toBe(true)
    expect(capabilitySupported(c, 'usageLookup')).toBe(true)
  })

  it('CHOICE (URL_TOKEN): status + usage both supported', () => {
    const c = createConnector('p-choice', 'Choice', 'URL_TOKEN', {})
    expect(c.capabilities?.statusLookup).toBe(true)
    expect(c.capabilities?.usageLookup).toBe(true)
    expect(capabilitySupported(c, 'statusLookup')).toBe(true)
    expect(capabilitySupported(c, 'usageLookup')).toBe(true)
  })

  it('AIRHUB: status supported, usage clean-skip', () => {
    const c = createConnector('p-airhub', 'AirHub', 'AIRHUB', {})
    expect(c.capabilities?.statusLookup).toBe(true)
    expect(c.capabilities?.usageLookup).toBe(false)
    expect(capabilitySupported(c, 'statusLookup')).toBe(true)
    expect(capabilitySupported(c, 'usageLookup')).toBe(false)
  })
})
