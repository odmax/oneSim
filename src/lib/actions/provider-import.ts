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

      // Create/update ProviderPackage records only — ESIMPackage is created on publish
      const existingPackage = await prisma.providerPackage.findFirst({
        where: { providerId, providerPlanId: normalized.providerPlanId },
      })

      if (existingPackage) {
        await prisma.providerPackage.update({
          where: { id: existingPackage.id },
          data: {
            name: normalized.name,
            dataGB: normalized.dataGB,
            validityDays: normalized.validityDays,
            costPrice: normalized.costPriceUSD,
            providerPlanCode: normalized.sku,
            providerRawData: normalized.rawData,
            isAvailable: true,
          },
        })

        await prisma.auditLog.create({
          data: { userId, action: 'PROVIDER_PLAN_UPDATED', entity: 'ProviderPackage', entityId: existingPackage.id, details: `Updated package from ${provider.code} plan: ${normalized.name} (${normalized.providerPlanId})` },
        }).catch(() => {})

        results.push({ success: true, planId: normalized.providerPlanId, planName: normalized.name, packageId: existingPackage.id, reason: 'updated', _clientId })
      } else {
        const created = await prisma.providerPackage.create({
          data: {
            providerId,
            providerPlanId: normalized.providerPlanId,
            providerPlanCode: normalized.sku,
            name: normalized.name,
            dataGB: normalized.dataGB,
            validityDays: normalized.validityDays,
            costPrice: normalized.costPriceUSD,
            currency: 'USD',
            isAvailable: true,
            providerRawData: normalized.rawData,
            configurationStatus: 'UNCONFIGURED',
          },
        })

        await prisma.auditLog.create({
          data: { userId, action: 'PROVIDER_PLAN_IMPORTED', entity: 'ProviderPackage', entityId: created.id, details: `Imported package from ${provider.code} plan: ${normalized.name} (${normalized.providerPlanId})` },
        }).catch(() => {})

        results.push({ success: true, planId: normalized.providerPlanId, planName: normalized.name, packageId: created.id, reason: 'created', _clientId })
      }
    } catch (error: any) {
      results.push({ success: false, planId: getPlanIdFromPlan(raw), planName: getPlanNameFromPlan(raw), reason: error.message || 'Import error', _clientId })
    }
  }

  revalidatePath(`/admin/providers/${providerId}`)
  revalidatePath('/admin/packages')
  revalidatePath('/admin/provider-catalog')

  return { results }
}
