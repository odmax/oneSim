import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { generateSku, generatePackageCode } from '@/lib/packages/resolve-package'
import { normalizePlan } from '@/lib/providers/plan-utils'
import type { ImportResult } from '@/lib/providers/plan-utils'

function extractCountry(rawData: string): string | null {
  try {
    const parsed = JSON.parse(rawData)
    return parsed.country || parsed.region || null
  } catch {
    return null
  }
}

function getPlanIdFromPlan(raw: any): string {
  if (raw.providerPlanId) return String(raw.providerPlanId)
  if (raw.sku) return String(raw.sku)
  if (raw.id) return String(raw.id)
  const rd = raw?.raw_data || raw?.providerRawData
  if (rd) {
    if (rd.bundle_template_id) return String(rd.bundle_template_id)
    if (rd.sku) return String(rd.sku)
    if (rd.id) return String(rd.id)
  }
  return 'unknown'
}

function getPlanNameFromPlan(raw: any): string {
  if (raw.name) return String(raw.name)
  const rd = raw?.raw_data || raw?.providerRawData
  if (rd?.bundle_name) return String(rd.bundle_name)
  if (rd?.name) return String(rd.name)
  return 'unknown'
}

export async function importProviderPlans(providerId: string, plans: any[], userId: string): Promise<{ results: ImportResult[] }> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { results: [] }

  const results: ImportResult[] = []

  for (const raw of plans) {
    const _clientId = raw._clientId || ''
    try {
      const normalized = normalizePlan(raw)

      if (!normalized.providerPlanId || !normalized.name) {
        normalized.normalizedDebug.providerId = providerId
        results.push({
          success: false,
          planId: getPlanIdFromPlan(raw),
          planName: getPlanNameFromPlan(raw),
          reason: `Missing required fields: ${normalized.normalizedDebug.missingFields.join(', ')}`,
          normalizedDebug: normalized.normalizedDebug,
          _clientId,
        })
        continue
      }

      const sku = generateSku(normalized.name, normalized.dataGB, normalized.validityDays, provider.code)
      let packageCode = generatePackageCode(normalized.dataGB, normalized.validityDays)

      let existingCode = await prisma.eSIMPackage.findUnique({ where: { packageCode } })
      while (existingCode) {
        packageCode = generatePackageCode(normalized.dataGB, normalized.validityDays)
        existingCode = await prisma.eSIMPackage.findUnique({ where: { packageCode } })
      }

      const existingPackage = await prisma.eSIMPackage.findFirst({
        where: { providerId, providerPlanId: normalized.providerPlanId },
      })

      if (existingPackage) {
        await prisma.eSIMPackage.update({
          where: { id: existingPackage.id },
          data: {
            source: 'PROVIDER_PLAN',
            name: normalized.name,
            description: normalized.description || existingPackage.description,
            dataGB: normalized.dataGB,
            validityDays: normalized.validityDays,
            costPriceUSD: normalized.costPriceUSD,
            priceUSD: 0,
            localPrice: 0,
            providerRawData: normalized.rawData,
            sku: existingPackage.sku || sku,
            packageCode: existingPackage.packageCode || packageCode,
          },
        })

        await prisma.auditLog.create({
          data: { userId, action: 'PROVIDER_PLAN_UPDATED', entity: 'ESIMPackage', entityId: existingPackage.id, details: `Updated package from ${provider.code} plan: ${normalized.name} (${normalized.providerPlanId})` },
        }).catch(() => {})

        results.push({ success: true, planId: normalized.providerPlanId, planName: normalized.name, packageId: existingPackage.id, reason: 'updated', _clientId })
      } else {
        const created = await prisma.eSIMPackage.create({
          data: {
            source: 'PROVIDER_PLAN',
            name: normalized.name,
            description: normalized.description || `Imported from ${provider.name}: ${normalized.name}`,
            dataGB: normalized.dataGB,
            validityDays: normalized.validityDays,
            priceUSD: 0,
            localPrice: 0,
            currency: 'USD',
            isActive: false,
            sku,
            packageCode,
            providerId,
            providerName: provider.code,
            providerPlanId: normalized.providerPlanId,
            providerRawData: normalized.rawData,
            costPriceUSD: normalized.costPriceUSD,
          },
        })

        await prisma.auditLog.create({
          data: { userId, action: 'PROVIDER_PLAN_IMPORTED', entity: 'ESIMPackage', entityId: created.providerPlanId || created.id, details: `Imported package from ${provider.code} plan: ${normalized.name} (${normalized.providerPlanId})` },
        }).catch(() => {})

        results.push({ success: true, planId: normalized.providerPlanId, planName: normalized.name, packageId: created.id, reason: 'created', _clientId })
      }
    } catch (error: any) {
      results.push({ success: false, planId: getPlanIdFromPlan(raw), planName: getPlanNameFromPlan(raw), reason: error.message || 'Import error', _clientId })
    }
  }

  revalidatePath(`/admin/providers/${providerId}`)
  revalidatePath('/admin/packages')

  return { results }
}
