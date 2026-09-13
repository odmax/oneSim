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
    name: 'Regional 35GB',
    displayName: 'Regional 35GB Plan',
    description: 'desc',
    customerDescription: 'cust',
    dataGB: 35,
    validityDays: 30,
    currency: 'USD',
    priceUSD: 29.99,
    productType: 'NEW_ESIM',
    isActive: true,
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
})