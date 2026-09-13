import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPackage: { findMany: vi.fn() },
  },
}))

const { prisma } = await import('@/lib/prisma')
const { getSkuExportData, skuToJson, skuToCsv, skuToXlsx } = await import('./sku-export')

const mockPrisma = vi.mocked(prisma)

const PROVIDER_TOKENS = ['AIRHUB', 'CHOICE', 'TELNA', 'IBASIS', '24MOBILECONNECT', 'USMATRIX', 'SECRET_PROVIDER_X']

function leakedPackage(provider: string, overrides: any = {}) {
  return {
    id: 'retail-1',
    providerPackageId: `pp-${provider.toLowerCase()}-000`,
    sku: `OS-${provider}-XX-35GB-30D-AJ33VU`, // legacy persisted SKU leaks the provider
    packageCode: `OS-${provider}-XX-35GB-30D-AJ33VU`,
    name: `${provider} Test - 35GB - Global - 30 Days`, // provider-branded copy
    displayName: `${provider} Test - 35GB - Global - 30 Days`,
    description: `Powered by ${provider} with global roaming`,
    customerDescription: `${provider} worldwide coverage`,
    dataGB: 35,
    validityDays: 30,
    currency: 'USD',
    priceUSD: 29.99,
    productType: 'NEW_ESIM',
    isActive: true,
    providerName: provider,
    providerPackage: { country: 'ZA', region: null },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getSkuExportData — provider-neutral SKU downloads', () => {
  it.each(PROVIDER_TOKENS)('JSON export never contains the provider %s', async (provider) => {
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([leakedPackage(provider)] as any)
    const data = await getSkuExportData()
    const json = skuToJson(data)
    expect(json.toUpperCase()).not.toContain(provider.toUpperCase().replace(/\s+/g, ''))
    expect(json).not.toContain('providerName')
  })

  it.each(PROVIDER_TOKENS)('CSV export never contains the provider %s and drops the providerName column', async (provider) => {
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([leakedPackage(provider)] as any)
    const data = await getSkuExportData()
    const csv = skuToCsv(data)
    expect(csv.toUpperCase()).not.toContain(provider.toUpperCase().replace(/\s+/g, ''))
    expect(csv).not.toMatch(/providerName/i)
    expect(csv.split('\n')[0].startsWith('sku,packageCode,name,')).toBe(true)
  })

  it('XLSX export never contains the provider name/code', async () => {
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([leakedPackage('AIRHUB')] as any)
    const data = await getSkuExportData()
    const xlsx = skuToXlsx(data)
    expect(xlsx.toUpperCase()).not.toContain('AIRHUB')
    expect(xlsx).not.toMatch(/providerName/i)
  })

  it('exports the canonical provider-neutral public SKU (OS-{COUNTRY}-{DATA}GB-{VALIDITY}D-{SUFFIX}) instead of the persisted value', async () => {
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([leakedPackage('CHOICE')] as any)
    const data = await getSkuExportData()
    expect(data[0].sku.startsWith('OS-ZA-35GB-30D-')).toBe(true)
    expect(data[0].packageCode.startsWith('OS-ZA-35GB-30D-')).toBe(true)
    expect(data[0].sku).not.toContain('CHOICE')
    expect(data[0].providerName).toBeUndefined()
  })

  it('is stable across repeated export calls for the same package', async () => {
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([leakedPackage('USMATRIX')] as any)
    const a = await getSkuExportData()
    const b = await getSkuExportData()
    expect(a[0].sku).toBe(b[0].sku)
  })

  it.each(PROVIDER_TOKENS)('package TEXT metadata never leaks provider %s in JSON/CSV/XLSX', async (provider) => {
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([leakedPackage(provider)] as any)
    const data = await getSkuExportData()
    const token = provider.toUpperCase().replace(/[\s-]/g, '')
    expect(data[0].name.toUpperCase()).not.toContain(token)
    expect((data[0].displayName || '').toUpperCase()).not.toContain(token)
    expect((data[0].description || '').toUpperCase()).not.toContain(token)
    expect((data[0].customerDescription || '').toUpperCase()).not.toContain(token)
    for (const out of [skuToJson(data), skuToCsv(data), skuToXlsx(data)]) {
      expect(out.toUpperCase()).not.toContain(token)
    }
  })

  it('preserves geography/data/validity in the neutral public name', async () => {
    mockPrisma.eSIMPackage.findMany.mockResolvedValue([leakedPackage('TELNA')] as any)
    const data = await getSkuExportData()
    expect(data[0].name.toUpperCase()).not.toContain('TELNA')
    expect(data[0].name).toMatch(/Global|35GB|30/i)
  })
})