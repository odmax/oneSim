import { prisma } from '../../src/lib/prisma'
import { PROVIDER_STRATEGIES, type ProviderStrategy } from './scenarios'
import { classifyLoadDb } from './load-db'
import { assertLoadDbBinding } from './bootstrap'

export const STRATEGY_TO_CONNECTOR_TYPE: Record<string, string> = {
  CHOICE: 'URL_TOKEN',
}
export function connectorTypeForStrategy(s: ProviderStrategy): string {
  return STRATEGY_TO_CONNECTOR_TYPE[s] ?? s
}

export interface SeedOptions {
  businesses: number
  walletBalance: number
  packagesPerProvider: number
  providers: string[]
  quantity: number
  /** Per-run package namespace — keeps (business,package) combos unique across
   *  matrix cells so the real 30s dedup window never collapses a cell's fresh
   *  purchases onto a previous cell's orders. */
  scope?: string
}

export interface SeedResult {
  businessIds: string[]
  userIds: string[]
  packageIdsPerBusiness: string[][] // [businessIdx] -> retail package ids
}

async function seedProvider(strategy: ProviderStrategy): Promise<string> {
  const existing = await prisma.provider.findFirst({ where: { code: strategy } })
  if (existing) return existing.id
  return (await prisma.provider.create({
    data: {
      code: strategy,
      name: `Load ${strategy}`,
      type: 'CUSTOM',
      status: 'ACTIVE',
      environment: 'load',
      adapterStrategy: strategy,
      apiBaseUrl: 'fake://load',
      apiToken: 'enc:fake',
      enabledCapabilities: ['PURCHASE'] as any,
      config: { loadProvider: true } as any,
    },
  })).id
}

async function seedZero(): Promise<void> {
  const p = prisma as any
  // Idempotency: re-run only creates missing rows; deterministic keyed seeds,
  // plus we tag provider packages with providerPlanId `LOAD-<strategy>-1` and
  // look them up first so repeated runs do not duplicate.
  await p.providerPackage.count()
}

export async function seedLoad(opts: SeedOptions): Promise<SeedResult> {
  await seedZero()
  const businessIds: string[] = []
  const userIds: string[] = []
  const packageIdsPerBusiness: string[][] = []

  const providerIdByStrategy = new Map<string, string>()
  for (const strategy of PROVIDER_STRATEGIES) {
    if (!opts.providers.includes(strategy)) continue
    providerIdByStrategy.set(strategy, await seedProvider(strategy))
  }

  const scope = opts.scope ?? 'base'
  for (let b = 0; b < opts.businesses; b++) {
    const bizEmail = `load-${scope}-b${b}@onesim.test`
    let business = await prisma.business.findFirst({ where: { name: `Load ${scope} Business ${b}` } })
    if (!business) {
      business = await prisma.business.create({
        data: { name: `Load ${scope} Business ${b}`, contactEmail: bizEmail, country: 'ZA', status: 'APPROVED', walletBalance: opts.walletBalance } as any,
      })
    }
    businessIds.push(business.id)

    let user = await prisma.user.findUnique({ where: { email: bizEmail } })
    if (!user) {
      user = await prisma.user.create({ data: { email: bizEmail, name: `Load User ${b}`, role: 'BUSINESS_USER' } as any })
    }
    userIds.push(user.id)

    const pkgIds: string[] = []
    const strategy = opts.providers.length > 0 ? opts.providers[b % opts.providers.length] as ProviderStrategy : 'AIRHUB'
    const providerId = providerIdByStrategy.get(strategy)!
    for (let p = 0; p < opts.packagesPerProvider; p++) {
      const planId = `LOAD-${strategy}-${b}-${p}-${scope}`
      const retailName = `Load ${strategy} ${p} for B${b}`
      let providerPkg = await prisma.providerPackage.findFirst({ where: { providerPlanId: planId } })
      if (!providerPkg) {
        providerPkg = await prisma.providerPackage.create({
          data: {
            providerId,
            providerPlanId: planId,
            name: retailName,
            dataGB: 1,
            validityDays: 7,
            costPrice: 0.5,
            sellingPrice: 1.0,
            currency: 'USD',
            sellingCurrency: 'USD',
            pricingMode: 'FIXED_PRICE',
            costStatus: 'VALID',
            pricingStatus: 'READY',
            publishStatus: 'PUBLISHED',
            configurationStatus: 'CONFIGURED',
            activationPolicy: 'IMMEDIATE',
            travelDateRequirement: 'NOT_REQUIRED',
            travelDateLeadDays: 0,
            providerRawData: {} as any,
          } as any,
        })
        const snapshot = await prisma.packagePriceSnapshot.create({
          data: {
            providerPackageId: providerPkg.id,
            originalCostAmount: 0.5,
            originalCostCurrency: 'USD',
            effectiveCostAmount: 0.5,
            effectiveCostCurrency: 'USD',
            baseSellingPrice: 1.0,
            finalSellingPrice: 1.0,
            sellingCurrency: 'USD',
            profitAmount: 0.5,
            marginPercent: 50,
            pricingEngineVersion: 'LOAD',
            reason: 'load seed',
            status: 'ACTIVE',
          } as any,
        })
        await prisma.providerPackage.update({ where: { id: providerPkg.id }, data: { activePriceSnapshotId: snapshot.id } as any })
      }
      const retailSku = `load-${scope}-${b}-${p}-${strategy}`
      let retail = await prisma.eSIMPackage.findUnique({ where: { sku: retailSku } })
      if (!retail) {
        const created = await prisma.eSIMPackage.create({
          data: {
            name: retailName,
            displayName: retailName,
            dataGB: 1,
            validityDays: 7,
            priceUSD: 1.0,
            localPrice: 1.0,
            currency: 'USD',
            sku: retailSku,
            packageCode: `PKG-${scope}-${strategy}-${b}-${p}`,
            source: 'CATALOG_PRODUCT',
            productType: 'NEW_ESIM',
            isActive: true,
            hiddenFromCatalog: false,
            providerPackage: { connect: { id: providerPkg.id } },
          } as any,
        })
        pkgIds.push(created.id)
      } else {
        pkgIds.push(retail.id)
      }
    }
    packageIdsPerBusiness.push(pkgIds)
  }

  return { businessIds, userIds, packageIdsPerBusiness }
}

export async function teardownLoadSeed(): Promise<void> {
  // SELF-GATED destructive cleanup — never run any deleteMany against a
  // non-load DB, regardless of how the caller was (mis)bound. Mirrors the
  // harness entrypoint discipline: LOAD_HARNESS=1 + onesim_load_* name +
  // non-staging/prod host + current_database() === expected load DB.
  if (process.env.LOAD_HARNESS !== '1') {
    throw new Error('TEARDOWN_GATE: LOAD_HARNESS mode not enabled')
  }
  const gate = classifyLoadDb(process.env.DATABASE_URL!)
  if (!gate.ok || gate.stagingDbUsed || gate.productionDbUsed) {
    throw new Error(`TEARDOWN_GATE: ${gate.reason || 'staging/production-like host rejected'}`)
  }
  const actualDb = await prisma.$queryRawUnsafe('SELECT current_database() AS db').then((r: any) => (r && r[0] ? String(r[0].db) : '')).catch(() => '')
  assertLoadDbBinding(actualDb, gate.databaseName)

  await prisma.eSIMPackage.deleteMany({ where: { sku: { startsWith: 'load-' } } }).catch(() => {})
  await prisma.packagePriceSnapshot.deleteMany({ where: { pricingEngineVersion: 'LOAD' } }).catch(() => {})
  await prisma.providerPackage.deleteMany({ where: { providerPlanId: { startsWith: 'LOAD-' } } }).catch(() => {})
  await prisma.business.deleteMany({ where: { name: { startsWith: 'Load Business' } } }).catch(() => {})
  await prisma.provider.deleteMany({ where: { code: { in: [...PROVIDER_STRATEGIES] } } }).catch(() => {})
}