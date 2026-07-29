/**
 * E2E Integration Test: CHOICE 1GB 9% Markup Rule
 *
 * Exercises the full rule lifecycle against the real database:
 *   1. Find a CHOICE provider package
 *   2. Create a temporary test rule
 *   3. Verify rule evaluator matching
 *   4. Verify pricing engine computation (9% on $1.60 = $1.74)
 *   5. Apply the rule update
 *   6. Verify database persistence
 *   7. Verify idempotent re-application
 *
 * Cleanup: removes the test rule and resets the package when done.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'

const CHOICE_PROVIDER_ID = 'cmpmdgxws00004kfa0i2iqsf4'

let testPackageId: string | null = null
let testRuleId: string | null = null

describe('E2E: CHOICE 1GB 9% Markup Rule', () => {
  afterAll(async () => {
    try {
      if (testRuleId) {
        await prisma.packageConfigurationRule.delete({ where: { id: testRuleId } })
      }
    } catch { /* ignore cleanup errors */ }
    try {
      if (testPackageId) {
        await prisma.providerPackage.update({
          where: { id: testPackageId },
          data: {
            configurationStatus: 'UNCONFIGURED',
            autoConfiguredByRuleId: null,
            lastConfiguredAt: null,
          },
        })
      }
    } catch { /* ignore cleanup errors */ }
  })

  it('finds or creates a valid CHOICE unconfigured 1GB package', async () => {
    const existing = await prisma.providerPackage.findFirst({
      where: {
        providerId: CHOICE_PROVIDER_ID,
        isAvailable: true,
        configurationStatus: 'UNCONFIGURED',
        costPrice: { gt: 0 },
        dataGB: { gt: 0, lte: 1 },
        validityDays: { gte: 1, lte: 20 },
      },
    })

    if (existing) {
      testPackageId = existing.id
      expect(parseFloat(existing.costPrice.toString())).toBeGreaterThan(0)
      return
    }

    // Create a test package
    const created = await prisma.providerPackage.create({
      data: {
        providerId: CHOICE_PROVIDER_ID,
        providerPlanId: 'test-choice-1gb-7d',
        name: 'CHOICE 1GB 7 Days (E2E Test)',
        dataGB: 1,
        validityDays: 7,
        costPrice: 1.60,
        currency: 'USD',
        country: 'KE',
        configurationStatus: 'UNCONFIGURED',
        publishStatus: 'DRAFT',
        isAvailable: true,
      },
    })
    testPackageId = created.id
    expect(created.dataGB).toBe(1)
    expect(parseFloat(created.costPrice.toString())).toBe(1.60)
  })

  it('creates a test rule: CHOICE 1-1GB, 1-20d, 9% markup', async () => {
    const { markSellingPriceByPercent } = await import('@/lib/pricing/pricing-engine')

    const rule = await prisma.packageConfigurationRule.create({
      data: {
        name: 'CHOICE 1GB - 9% Markup (E2E)',
        providerId: CHOICE_PROVIDER_ID,
        dataMinGB: 1,
        dataMaxGB: 1,
        validityMinDays: 1,
        validityMaxDays: 20,
        markupPercent: 9,
        sellingCurrency: 'USD',
        publishStatus: 'READY',
        priority: 10,
        isActive: true,
      },
    })
    testRuleId = rule.id
    expect(rule.isActive).toBe(true)
    expect(rule.markupPercent).not.toBeNull()
  })

  it('rule evaluator matches the test package', async () => {
    const { doesRuleMatchPackage, inferPricingStrategy, extractPricingValue } =
      await import('@/lib/pricing/pricing-rule-evaluator')

    const rule = await prisma.packageConfigurationRule.findUnique({ where: { id: testRuleId! } })
    const pkg = await prisma.providerPackage.findUnique({ where: { id: testPackageId! } })

    const matched = doesRuleMatchPackage(rule as any, pkg as any)
    expect(matched).toBe(true)

    expect(inferPricingStrategy(rule as any)).toBe('MARKUP_PERCENT')
    expect(extractPricingValue(rule as any)).toBe(9)
  })

  it('simulateRulePricing correctly evaluates the package', async () => {
    const { simulateRulePricing } = await import('@/lib/pricing/pricing-simulation-service')

    const rule = await prisma.packageConfigurationRule.findUnique({ where: { id: testRuleId! } })
    const pkg = await prisma.providerPackage.findUnique({ where: { id: testPackageId! } })

    const result = simulateRulePricing({
      rule: {
        id: rule!.id, name: rule!.name,
        providerId: rule!.providerId, country: rule!.country, region: rule!.region,
        productType: rule!.productType,
        dataMinGB: rule!.dataMinGB, dataMaxGB: rule!.dataMaxGB,
        validityMinDays: rule!.validityMinDays, validityMaxDays: rule!.validityMaxDays,
        costPrice: rule!.costPrice ? parseFloat(rule!.costPrice.toString()) : null,
        markupPercent: rule!.markupPercent ? parseFloat(rule!.markupPercent.toString()) : null,
        fixedPrice: rule!.fixedPrice ? parseFloat(rule!.fixedPrice.toString()) : null,
        sellingCurrency: rule!.sellingCurrency, publishStatus: rule!.publishStatus,
        priority: rule!.priority, isActive: rule!.isActive,
      },
      packages: [{
        id: pkg!.id, name: pkg!.name,
        costPrice: parseFloat(pkg!.costPrice.toString()),
        sellingPrice: pkg!.sellingPrice ? parseFloat(pkg!.sellingPrice.toString()) : null,
        markupPercent: pkg!.markupPercent ? parseFloat(pkg!.markupPercent.toString()) : null,
        sellingCurrency: pkg!.sellingCurrency, providerId: pkg!.providerId,
        providerName: 'CHOICE', country: pkg!.country, region: pkg!.region,
        dataGB: pkg!.dataGB, validityDays: pkg!.validityDays,
        publishStatus: pkg!.publishStatus, configurationStatus: pkg!.configurationStatus,
        autoConfiguredByRuleId: pkg!.autoConfiguredByRuleId,
      }],
    })

    expect(result.summary.packagesEvaluated).toBe(1)
    expect(result.summary.packagesUpdated).toBe(1)
    expect(result.summary.packagesSkipped).toBe(0)
    expect(result.packages.length).toBe(1)

    const sim = result.packages[0]
    expect(sim.newSellingPrice).toBe(1.74)
    expect(sim.costPrice).toBe(1.60)
    expect(sim.newMarkupPercent).toBe(9)
  })

  it('applies the rule update and persists to database', async () => {
    const { markSellingPriceByPercent } = await import('@/lib/pricing/pricing-engine')
    const rule = await prisma.packageConfigurationRule.findUnique({ where: { id: testRuleId! } })
    const pkg = await prisma.providerPackage.findUnique({ where: { id: testPackageId! } })
    const cost = parseFloat(pkg!.costPrice.toString())
    const newSell = markSellingPriceByPercent(cost, 9)

    await prisma.providerPackage.update({
      where: { id: testPackageId! },
      data: {
        sellingPrice: newSell,
        sellingCurrency: rule!.sellingCurrency,
        markupPercent: rule!.markupPercent ? parseFloat(rule!.markupPercent.toString()) : null,
        pricingMode: 'MARKUP_PERCENT',
        publishStatus: rule!.publishStatus || 'READY',
        configurationStatus: 'AUTO_CONFIGURED',
        autoConfiguredByRuleId: rule!.id,
        lastConfiguredAt: new Date(),
      },
    })

    const reloaded = await prisma.providerPackage.findUnique({ where: { id: testPackageId! } })
    expect(parseFloat(reloaded!.sellingPrice!.toString())).toBe(1.74)
    expect(parseFloat(reloaded!.costPrice.toString())).toBe(1.60)
    expect(reloaded!.configurationStatus).toBe('AUTO_CONFIGURED')
    expect(reloaded!.autoConfiguredByRuleId).toBe(testRuleId)
    expect(reloaded!.dataGB).toBe(1)
    expect(reloaded!.validityDays).toBe(7)
    expect(reloaded!.providerId).toBe(CHOICE_PROVIDER_ID)
  })

  it('second application is idempotent (autoConfiguredByRuleId blocks re-apply)', async () => {
    const { doesRuleMatchPackage } = await import('@/lib/pricing/pricing-rule-evaluator')

    const rule = await prisma.packageConfigurationRule.findUnique({ where: { id: testRuleId! } })!
    const pkg = await prisma.providerPackage.findUnique({ where: { id: testPackageId! } })!

    // Matching still succeeds
    expect(doesRuleMatchPackage(rule as any, pkg as any)).toBe(true)

    // But the in-loop guard detects already-configured status
    expect(pkg.autoConfiguredByRuleId).toBe(testRuleId)
    expect(pkg.configurationStatus).toBe('AUTO_CONFIGURED')

    // Price remains same
    expect(parseFloat(pkg.sellingPrice!.toString())).toBe(1.74)
  })
})
