'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { checkPermission, Permissions } from '@/lib/auth/permissions'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { UrlTokenConnector } from '@/lib/providers/connectors/url-token-connector'

export async function updateProviderBundle(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const bundleId = formData.get('bundleId') as string
  const providerId = formData.get('providerId') as string
  const sku = formData.get('sku') as string
  const bundleName = formData.get('bundleName') as string

  // Capture old version before update
  const old = await prisma.$queryRawUnsafe<any[]>(`SELECT "externalVersion" FROM provider_bundle_definitions WHERE id=$1`, bundleId).catch(() => [])
  const oldVersion = old[0]?.externalVersion || 'N/A'

  // Call provider adapter FIRST — do not persist local state before remote success
  const connector = await buildConnectorFromProvider(providerId) as any
  let newVersion = ''
  if (connector?.updateBundleTemplate) {
    const result = await connector.updateBundleTemplate({ sku, bundle_name: bundleName })
    if (!result.success) {
      redirect(`/admin/providers/bundles/${bundleId}?error=${encodeURIComponent(result.error?.message || 'update_failed')}`)
    }
    newVersion = result.data?.template_version || ''
  }

  // Persist local only after provider success
  await prisma.$executeRawUnsafe(`UPDATE provider_bundle_definitions SET "bundleName"=$1, "externalVersion"=$2, "updatedAt"=NOW() WHERE id=$3`,
    bundleName, newVersion || oldVersion, bundleId)

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'UPDATE_BUNDLE', entity: 'ProviderBundleDefinition', entityId: bundleId,
    details: `Updated bundle ${sku}: name="${bundleName}" version ${oldVersion}→${newVersion || 'unchanged'}` } }).catch(() => {})
  redirect(`/admin/providers/bundles/${bundleId}?success=updated`)
}

export async function importProviderBundles(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const providerId = formData.get('providerId') as string
  const bundleIds = formData.getAll('bundleIds') as string[]

  const connector = await buildConnectorFromProvider(providerId) as any
  // Choice: syncPlans() hits /account/v03_09/bundle_templates which IS the LIST_BUNDLES endpoint
  if (!connector?.syncPlans) redirect('/admin/providers/bundles?error=provider_not_supported')

  const result = await connector.syncPlans()
  if (!result.success || !result.data) redirect('/admin/providers/bundles?error=sync_failed')

  let imported = 0
  for (const plan of result.data) {
    if (!bundleIds.includes(plan.id)) continue
    const sku = plan.sku || plan.id
    const exists = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM provider_bundle_definitions WHERE "providerId"=$1 AND "externalSku"=$2`, providerId, sku
    ).catch(() => [])
    if (exists.length) continue

    await prisma.$executeRawUnsafe(
      `INSERT INTO provider_bundle_definitions ("providerId","externalSku","bundleCode","bundleName","dataAllowance","validityDays","externalVersion","pool","status","createdBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)`,
      providerId, sku, sku, plan.name, Math.round((plan.data_gb || 1) * 1024), plan.validity_days, plan.templateVersion || '',
      'imported', session.user.id
    )
    imported++
  }

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'IMPORT_BUNDLES', entity: 'Provider', entityId: providerId, details: `Imported ${imported} bundles` } }).catch(() => {})
  redirect(`/admin/providers/bundles?success=imported_${imported}`)
}

export async function configureBundleForSale(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')
  const perm = await checkPermission(Permissions.MANAGE_PRODUCTS)
  if (!perm.allowed) redirect('/admin/unauthorized')

  const bundleId = formData.get('bundleId') as string

  const bundle = await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM provider_bundle_definitions WHERE id=$1`, bundleId).catch(() => [])
  if (!bundle.length) redirect('/admin/providers/bundles?error=not_found')
  const b = bundle[0]

  const sku = b.externalSku || b.bundleCode
  let pp = await prisma.providerPackage.findFirst({ where: { providerPlanCode: sku } })

  if (!pp) {
    pp = await prisma.providerPackage.create({
      data: {
        providerId: b.providerId, providerPlanId: sku, providerPlanCode: sku, name: b.bundleName,
        dataGB: Math.max(1, Math.round((b.dataAllowance || 1024) / 1024)), validityDays: b.validityDays || 30,
        costPrice: 0, sellingPrice: 0, currency: 'USD', configurationStatus: 'UNCONFIGURED',
        country: 'GLOBAL', isAvailable: true,
      } as any,
    })
  }

  await prisma.$executeRawUnsafe(`UPDATE provider_bundle_definitions SET status='ACTIVE', "updatedAt"=NOW() WHERE id=$1`, bundleId)
  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'CONFIGURE_BUNDLE_FOR_SALE', entity: 'ProviderBundleDefinition', entityId: bundleId, details: `Linked to ProviderPackage ${pp.id}` } }).catch(() => {})
  redirect(`/admin/provider-catalog?provider=${b.providerId}`)
}
