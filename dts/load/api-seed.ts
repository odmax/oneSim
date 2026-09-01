import crypto from 'crypto'
import { prisma } from '../../src/lib/prisma'
import { hashApiKey } from '../../src/lib/api/auth'
import { seedLoad, type SeedResult } from './load-seed'

export interface ApiSeedOptions {
  businesses: number
  packagesPerProvider: number
  providers: string[]
  quantity: number
  scope: string
}

export interface ApiSeedResult extends SeedResult {
  /** businessId → raw bearer key (hashed form persisted to business_api_keys). */
  apiKeyByBusinessId: Map<string, string>
  apiKeyIdByBusinessId: Map<string, string>
}

function randomRawKey(): { raw: string; hash: string } {
  const raw = `onesim_${crypto.randomBytes(32).toString('hex')}`
  return { raw, hash: hashApiKey(raw) }
}

/**
 * Seed the public-API surface of the load DB: businesses + retail packages
 * (via the shared seed), one ADMIN BusinessUser per business (the order route
 * resolves the dispatch userId through business_users), an ACTIVE BusinessApiKey
 * per business, and a very high per-business rate-limit budget so the DB-backed
 * rate limiter does not distort an ingress measurement (DATA seeding only — the
 * rate-limit logic/code is untouched and audited separately).
 */
export async function seedApiLoad(opts: ApiSeedOptions): Promise<ApiSeedResult> {
  const base = await seedLoad({
    businesses: opts.businesses,
    walletBalance: 1_000_000,
    packagesPerProvider: opts.packagesPerProvider,
    providers: opts.providers,
    quantity: opts.quantity,
    scope: opts.scope,
  })

  const apiKeyByBusinessId = new Map<string, string>()
  const apiKeyIdByBusinessId = new Map<string, string>()

  for (let i = 0; i < base.businessIds.length; i++) {
    const businessId = base.businessIds[i]
    const userId = base.userIds[i]

    const existingAdmin = await prisma.businessUser.findFirst({ where: { businessId, role: 'ADMIN' as any } })
    if (!existingAdmin) {
      await prisma.businessUser.create({ data: { businessId, userId, role: 'ADMIN' as any } })
    }

    await prisma.business.update({
      where: { id: businessId },
      data: { rateLimitPerMinute: 10_000_000 } as any,
    })

    const key = randomRawKey()
    const created = await prisma.businessApiKey.create({
      data: {
        businessId,
        name: `Load ${opts.scope} B${i}`,
        keyHash: key.hash,
        keyPrefix: key.raw.slice(0, 12),
        status: 'ACTIVE' as any,
        scopes: [],
        environment: 'test',
      },
    })
    apiKeyByBusinessId.set(businessId, key.raw)
    apiKeyIdByBusinessId.set(businessId, created.id)
  }

  return { ...base, apiKeyByBusinessId, apiKeyIdByBusinessId }
}