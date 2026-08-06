/**
 * Schema integrity check — verifies critical Prisma model @@map directives are present.
 */
import fs from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

function loadSchemaLines(): string[] {
  const schemaPath = path.resolve('prisma/schema.prisma')
  return fs.readFileSync(schemaPath, 'utf-8').split('\n')
}

function getMapForModel(modelName: string, lines: string[]): string | null {
  let inModel = false
  let braceDepth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (inModel) {
      if (trimmed.startsWith('@@map(')) {
        const match = trimmed.match(/@@map\("([^"]+)"\)/)
        if (match) return match[1]
      }
      for (const char of trimmed) {
        if (char === '{') braceDepth++
        if (char === '}') braceDepth--
      }
      if (braceDepth === 0) return null
    } else if (trimmed.startsWith(`model ${modelName}`) || trimmed.startsWith(`model ${modelName} {`)) {
      inModel = true
      if (trimmed.includes('{')) braceDepth++
    }
  }
  return null
}

describe('Prisma schema integrity', () => {
  const lines = loadSchemaLines()

  const expectedMappings: Record<string, string> = {
    PurchaseQuote: 'purchase_quotes',
    PackagePriceSnapshot: 'package_price_snapshots',
    ProviderPackageFee: 'provider_package_fees',
    ProviderCostSnapshot: 'provider_cost_snapshots',
    OrderCallbackDelivery: 'order_callback_deliveries',
    ProviderInventoryReservation: 'provider_inventory_reservations',
    ProviderPackage: 'provider_packages',
    ESIMPackage: 'esim_packages',
    ESIMPurchase: 'esim_purchases',
  }

  for (const [modelName, expectedTable] of Object.entries(expectedMappings)) {
    it(`${modelName} maps to ${expectedTable}`, () => {
      const actual = getMapForModel(modelName, lines)
      expect(actual, `${modelName} is missing @@map("${expectedTable}")`).toBe(expectedTable)
    })
  }

  it('migration does not create PascalCase tables for purchase models', () => {
    // Verify no @@map creates a PascalCase table for quote/snapshot/cost models
    const snapshotMaps = lines
      .filter(l => l.includes('@@map('))
      .map(l => l.match(/@@map\("([^"]+)"\)/)?.[1])
      .filter(Boolean) as string[]
    const pascalCaseTables = snapshotMaps.filter(t => /[A-Z]/.test(t))
    // production convention: all @@map values should be snake_case
    expect(pascalCaseTables.length, `PascalCase @map values found: ${pascalCaseTables.join(', ')}`).toBe(0)
  })
})
