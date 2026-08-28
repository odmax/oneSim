import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockGetServerSession } = vi.hoisted(() => ({ mockGetServerSession: vi.fn() }))
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    provider: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`) } }))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/encryption', () => ({ encryptToken: (t: string) => `enc:${t}` }))
vi.mock('@/lib/providers/adapter-manager', () => ({
  buildAdapter: vi.fn(),
  isTemplateDrivenProvider: vi.fn(() => false),
}))
vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { createProvider } from './providers'

const mockP = vi.mocked(prisma)

function form(values: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(values)) fd.append(k, v)
  return fd
}

function adminSession() {
  return { user: { role: 'INTERNAL_ADMIN', id: 'admin-1' } }
}

const GENERIC_TEMPLATE_FORM = {
  name: 'Generic Template', code: 'RAKUTEN', type: 'CUSTOM', status: 'TESTING',
  environment: 'staging', priority: '10',
  // Stale saved-template style: endpoint mappings trigger isTemplate=true.
  endpointMappings: JSON.stringify({ AUTH_LOGIN: 'POST /auth', GET_PLANS: 'GET /plans', PURCHASE_ESIM: 'POST /buy' }),
}

let sessionValue: { user: { role: string; id: string } } | null
let upsertArg: any

beforeEach(() => {
  vi.clearAllMocks()
  sessionValue = adminSession()
  upsertArg = null
  mockGetServerSession.mockImplementation(async () => sessionValue)
  mockP.provider.findUnique.mockResolvedValue(null)
  mockP.provider.upsert.mockImplementation(async (args: any) => {
    upsertArg = args
    return { id: 'prov-1', ...args.create }
  })
})

afterEach(() => {
  sessionValue = null
})

describe('createProvider — AirHub canonical strategy invariant', () => {
  it('5. AIRHUB submitted with adapterStrategy=TEMPLATE is persisted as AIRHUB', async () => {
    const fd = form({ ...GENERIC_TEMPLATE_FORM, code: 'AIRHUB', adapterStrategy: 'TEMPLATE' })
    await expect(createProvider(fd)).rejects.toThrow(/REDIRECT/)
    expect(upsertArg).not.toBeNull()
    expect(upsertArg.where.code).toBe('AIRHUB')
    expect(upsertArg.create.code).toBe('AIRHUB')
    expect(upsertArg.create.adapterStrategy).toBe('AIRHUB')
    // No obsolete template-driven config for dedicated AirHub.
    const cfg = upsertArg.create.config || {}
    expect(cfg).not.toHaveProperty('providerMode')
    expect(cfg).not.toHaveProperty('templateDriven')
  })

  it('6. generic template-driven provider (RAKUTEN) remains TEMPLATE', async () => {
    const fd = form({ ...GENERIC_TEMPLATE_FORM, code: 'RAKUTEN', adapterStrategy: '' })
    await expect(createProvider(fd)).rejects.toThrow(/REDIRECT/)
    expect(upsertArg).not.toBeNull()
    expect(upsertArg.create.adapterStrategy).toBe('TEMPLATE')
    expect(upsertArg.create.config).toMatchObject({ providerMode: 'TEMPLATE', templateDriven: true })
  })

  it('7. stale saved AirHub template (providerTemplateId set) cannot create a TEMPLATE AirHub provider', async () => {
    const fd = form({
      ...GENERIC_TEMPLATE_FORM,
      code: 'AIRHUB',
      adapterStrategy: 'TEMPLATE',
      providerTemplateId: 'tpl-doc0',
      requestMappings: JSON.stringify({ AUTH_LOGIN: { userName: '{{username}}' } }),
    })
    await expect(createProvider(fd)).rejects.toThrow(/REDIRECT/)
    expect(upsertArg).not.toBeNull()
    expect(upsertArg.create.code).toBe('AIRHUB')
    expect(upsertArg.create.adapterStrategy).toBe('AIRHUB')
    const cfg = upsertArg.create.config || {}
    expect(cfg).not.toHaveProperty('providerMode')
    expect(cfg).not.toHaveProperty('templateDriven')
  })

  it('AIRHUB always wins regardless of stale strategy value (CUSTOM / REST_CATALOG / STANDARD)', async () => {
    for (const stale of ['CUSTOM', 'REST_CATALOG', 'STANDARD']) {
      vi.clearAllMocks()
      upsertArg = null
      mockGetServerSession.mockImplementation(async () => sessionValue)
      mockP.provider.findUnique.mockResolvedValue(null)
      mockP.provider.upsert.mockImplementation(async (args: any) => {
        upsertArg = args
        return { id: 'prov-1', ...args.create }
      })
      const fd = form({ ...GENERIC_TEMPLATE_FORM, code: 'AIRHUB', adapterStrategy: stale })
      await expect(createProvider(fd)).rejects.toThrow(/REDIRECT/)
      expect(upsertArg.create.adapterStrategy).toBe('AIRHUB')
    }
  })

  it('no loose name matching: AIRHUB2 / Airhub-X are NOT forced to AIRHUB', async () => {
    for (const code of ['AIRHUB2', 'Airhub-X', 'AIRHUB_EXTRA']) {
      vi.clearAllMocks()
      upsertArg = null
      mockGetServerSession.mockImplementation(async () => sessionValue)
      mockP.provider.findUnique.mockResolvedValue(null)
      mockP.provider.upsert.mockImplementation(async (args: any) => {
        upsertArg = args
        return { id: 'prov-1', ...args.create }
      })
      const fd = form({ name: 'X', code, type: 'CUSTOM', status: 'TESTING', environment: 'staging', adapterStrategy: 'REST_CATALOG' })
      await expect(createProvider(fd)).rejects.toThrow(/REDIRECT/)
      expect(upsertArg.create.adapterStrategy).toBe('REST_CATALOG')
    }
  })

  it('IBASIS / TELNA / USMATRIX behavior unchanged', async () => {
    const cases: Array<[string, string]> = [
      ['IBASIS', 'IBASIS'],
      ['TELNA', 'TELNA'],
      ['USMATRIX', 'USMATRIX'],
      ['MOCK', 'MOCK'],
    ]
    for (const [code, strategy] of cases) {
      vi.clearAllMocks()
      upsertArg = null
      mockGetServerSession.mockImplementation(async () => sessionValue)
      mockP.provider.findUnique.mockResolvedValue(null)
      mockP.provider.upsert.mockImplementation(async (args: any) => {
        upsertArg = args
        return { id: 'prov-1', ...args.create }
      })
      const fd = form({ name: code, code, type: code === 'MOCK' ? 'MOCK' : 'CUSTOM', status: 'TESTING', environment: 'staging', adapterStrategy: strategy })
      // IBASIS^ check: createProvider redirects if IBASIS strategy not matched with code IBASIS; MOCK type short-circuits.
      if (code === 'MOCK') {
        await expect(createProvider(fd)).rejects.toThrow(/REDIRECT/)
        expect(upsertArg.create.adapterStrategy).toBe('MOCK')
      } else {
        await expect(createProvider(fd)).rejects.toThrow(/REDIRECT/)
        expect(upsertArg.create.adapterStrategy).toBe(strategy)
      }
    }
  })
})