'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { buildAdapter } from '@/lib/providers/adapter-manager'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { encryptToken } from '@/lib/encryption'

function tryParseJson(raw: string): any {
  try { return JSON.parse(raw) } catch { return null }
}

export async function createProvider(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const name = formData.get('name') as string
  const code = formData.get('code') as string
  const type = formData.get('type') as string
  const status = (formData.get('status') as string) || 'ACTIVE'
  const authType = formData.get('authType') as string
  const apiVersion = formData.get('apiVersion') as string
  const apiBaseUrl = formData.get('apiBaseUrl') as string
  const authUrl = formData.get('authUrl') as string
  const apiToken = formData.get('apiToken') as string
  const adapterStrategy = formData.get('adapterStrategy') as string
  const environment = formData.get('environment') as string
  const priority = parseInt(formData.get('priority') as string) || 0
  const isDefaultFallback = formData.get('isDefaultFallback') === 'on'
  const regionsRaw = formData.get('regions') as string
  const supportsESIM = formData.get('supportsESIM') === 'on'
  const supportsUsage = formData.get('supportsUsage') === 'on'
  const supportsTopUp = formData.get('supportsTopUp') === 'on'
  const supportsSuspend = formData.get('supportsSuspend') === 'on'
  const supportsQRCode = formData.get('supportsQRCode') === 'on'
  const supportsPools = formData.get('supportsPools') === 'on'
  const supportsTemplates = formData.get('supportsTemplates') === 'on'
  const supportsUsageSync = formData.get('supportsUsageSync') === 'on'
  const supportsWebhookPush = formData.get('supportsWebhookPush') === 'on'
  const supportsSuspendResume = formData.get('supportsSuspendResume') === 'on'
  const endpointMappingsRaw = formData.get('endpointMappings') as string

  if (!name || !code || !type) {
    redirect('/admin/providers/new?error=Name%2C+Code%2C+and+Type+are+required')
  }

  // Validate adapterStrategy — required for non-MOCK providers
  const resolvedStrategy = adapterStrategy || (type === 'MOCK' ? 'MOCK' : null)
  if (!resolvedStrategy) {
    redirect('/admin/providers/new?error=Adapter+Strategy+is+required+for+non-MOCK+providers')
  }

  const existing = await prisma.provider.findUnique({ where: { code } })
  if (existing) {
    redirect(`/admin/providers/new?error=Provider+code+%22${code}%22+already+exists`)
  }

  let regions: any = null
  if (regionsRaw) {
    try { regions = JSON.parse(regionsRaw) } catch { redirect('/admin/providers/new?error=Invalid+JSON+in+regions') }
  }

  if (isDefaultFallback) {
    await prisma.provider.updateMany({ where: { isDefaultFallback: true }, data: { isDefaultFallback: false } })
  }

  const provider = await prisma.provider.create({
    data: {
      name,
      code: code.toUpperCase(),
      type: type === 'MOCK' ? 'MOCK' : 'CUSTOM',
      adapterStrategy: resolvedStrategy,
      tokenPlacement: 'URL_PATH',
      status: status as any,
      authType: authType || 'bearer_token',
      apiVersion: apiVersion || 'v1',
      apiBaseUrl: apiBaseUrl || null,
      authUrl: authUrl || null,
      apiToken: encryptToken(apiToken),
      environment: environment || 'staging',
      priority,
      isDefaultFallback: isDefaultFallback || false,
      regions,
      supportsESIM,
      supportsUsage,
      supportsTopUp,
      supportsSuspend,
      supportsQRCode,
      supportsPools,
      supportsTemplates,
      supportsUsageSync,
      supportsWebhookPush,
      supportsSuspendResume,
      endpointMappings: endpointMappingsRaw ? tryParseJson(endpointMappingsRaw) : undefined,
    },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_CREATED', entity: 'Provider', entityId: code.toUpperCase(), details: `Provider "${name}" (${code.toUpperCase()}) created` },
  })

  revalidatePath('/admin/providers')
  redirect(`/admin/providers/${provider.id}?setup=true`)
}

export async function updateProvider(providerId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const existingProvider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!existingProvider) redirect('/admin/providers?error=Provider+not+found')

  const name = formData.get('name') as string
  const status = (formData.get('status') as string) || undefined
  const authType = formData.get('authType') as string
  const apiVersion = formData.get('apiVersion') as string
  const apiBaseUrl = formData.get('apiBaseUrl') as string
  const authUrl = formData.get('authUrl') as string
  const apiToken = formData.get('apiToken') as string
  const environment = formData.get('environment') as string
  const priority = parseInt(formData.get('priority') as string) || 0
  const isDefaultFallback = formData.get('isDefaultFallback') === 'on'
  const regionsRaw = formData.get('regions') as string

  // Endpoint path fields
  const planListPath = formData.get('planListPath') as string
  const activationPath = formData.get('activationPath') as string
  const statusPath = formData.get('statusPath') as string
  const usagePath = formData.get('usagePath') as string
  const suspendPath = formData.get('suspendPath') as string
  const resumePath = formData.get('resumePath') as string
  const topUpPath = formData.get('topUpPath') as string
  const responseListKey = formData.get('responseListKey') as string
  const tokenPlacement = formData.get('tokenPlacement') as string

  // Field mappings
  const fieldSku = formData.get('fieldSku') as string
  const fieldName = formData.get('fieldName') as string
  const fieldData = formData.get('fieldData') as string
  const fieldValidity = formData.get('fieldValidity') as string
  const fieldCost = formData.get('fieldCost') as string

  // Activation endpoint mapping
  const activationMethod = formData.get('activationMethod') as string
  const activationBodyTemplate = formData.get('activationBodyTemplate') as string

  if (!name) redirect(`/admin/providers/${providerId}/edit?error=Name+is+required`)

  let regions: any = undefined
  if (regionsRaw) {
    try { regions = JSON.parse(regionsRaw) } catch { redirect(`/admin/providers/${providerId}/edit?error=Invalid+JSON+in+regions`) }
  }

  const update: any = {
    name,
    status: status || undefined,
    authType: authType || 'bearer_token',
    apiVersion: apiVersion || 'v1',
    environment: environment || 'staging',
    priority,
  }

  // Endpoint paths
  if (planListPath !== undefined) update.planListPath = planListPath || null
  if (activationPath !== undefined) update.activationPath = activationPath || null
  if (statusPath !== undefined) update.statusPath = statusPath || null
  if (usagePath !== undefined) update.usagePath = usagePath || null
  if (suspendPath !== undefined) update.suspendPath = suspendPath || null
  if (resumePath !== undefined) update.resumePath = resumePath || null
  if (topUpPath !== undefined) update.topUpPath = topUpPath || null
  if (responseListKey !== undefined) update.responseListKey = responseListKey || null
  if (tokenPlacement) update.tokenPlacement = tokenPlacement

  // Capability checkboxes — reads 'on' if checked (checkbox), backwards compatible with existing values
  const capKeys = ['supportsESIM', 'supportsUsage', 'supportsTopUp', 'supportsSuspend', 'supportsQRCode', 'supportsPools', 'supportsTemplates', 'supportsUsageSync', 'supportsWebhookPush', 'supportsSuspendResume'] as const
  for (const key of capKeys) {
    update[key] = formData.get(key) === 'on'
  }

  // Field mappings — always rebuild from form fields
  const fieldMappings: Record<string, string> = {}
  if (fieldSku) fieldMappings.sku = fieldSku
  if (fieldName) fieldMappings.name = fieldName
  if (fieldData) fieldMappings.data_gb = fieldData
  if (fieldValidity) fieldMappings.validity_days = fieldValidity
  if (fieldCost) fieldMappings.price_usd = fieldCost
  update.fieldMappings = fieldMappings

  // Endpoint mappings — merge with existing to preserve template-driven mappings
  const endpointMappingsRaw = formData.get('endpointMappings') as string
  const existingMappings = existingProvider.endpointMappings as Record<string, any> || {}
  if (endpointMappingsRaw) {
    try {
      const parsed = JSON.parse(endpointMappingsRaw)
      update.endpointMappings = { ...existingMappings, ...parsed }
    } catch {
      update.endpointMappings = { ...existingMappings }
    }
  } else {
    // Legacy single-activation mapping
    let bodyTemplate: any = undefined
    if (activationBodyTemplate) {
      try { bodyTemplate = JSON.parse(activationBodyTemplate) } catch { /* ignore invalid JSON */ }
    }
    const actMapping: any = { method: activationMethod || 'POST' }
    if (bodyTemplate) actMapping.body = bodyTemplate
    update.endpointMappings = { ...existingMappings, activate: actMapping }
  }

  // If setting as default fallback, clear others
  if (isDefaultFallback) {
    await prisma.provider.updateMany({ where: { isDefaultFallback: true, id: { not: providerId } }, data: { isDefaultFallback: false } })
  }
  update.isDefaultFallback = isDefaultFallback
  if (regions !== undefined) update.regions = regions

  if (apiBaseUrl) update.apiBaseUrl = apiBaseUrl
  if (authUrl) update.authUrl = authUrl
  if (apiToken) update.apiToken = encryptToken(apiToken)

  await prisma.provider.update({ where: { id: providerId }, data: update })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_UPDATED', entity: 'Provider', entityId: providerId, details: `Provider "${name}" updated` },
  })

  revalidatePath('/admin/providers')
  revalidatePath(`/admin/providers/${providerId}`)
  redirect(`/admin/providers/${providerId}?success=Provider+updated+successfully`)
}

export async function toggleProviderStatus(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return

  // Archived is a terminal state — use Lifecycle Management actions instead
  if (provider.status === 'ARCHIVED') return

  // Cycle: ACTIVE -> INACTIVE -> MAINTENANCE -> TESTING -> DEGRADED -> ACTIVE
  const cycle: Record<string, string> = { ACTIVE: 'INACTIVE', INACTIVE: 'MAINTENANCE', MAINTENANCE: 'TESTING', TESTING: 'DEGRADED', DEGRADED: 'ACTIVE' }
  const newStatus = cycle[provider.status] || 'ACTIVE'

  await prisma.provider.update({ where: { id: providerId }, data: { status: newStatus as any } })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_STATUS_CHANGED', entity: 'Provider', entityId: provider.code, details: `Provider "${provider.name}" status changed from ${provider.status} to ${newStatus}` },
  })

  revalidatePath('/admin/providers')
  revalidatePath(`/admin/providers/${providerId}`)
}

async function recordProviderHealth(providerId: string, success: boolean, errorMessage?: string) {
  const update: any = {}
  if (success) {
    update.lastSuccessfulConnection = new Date()
    // Reset error count on success
    update.errorCount = 0
  } else {
    update.lastFailedConnection = new Date()
    update.lastError = errorMessage || null
    // Increment error count
    const current = await prisma.provider.findUnique({ where: { id: providerId }, select: { errorCount: true } })
    update.errorCount = (current?.errorCount || 0) + 1
  }
  await prisma.provider.update({ where: { id: providerId }, data: update })
}

export async function testProviderConnection(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  })
  if (!provider) return { success: false, error: 'Provider not found' }

  try {
    // Prefer new connector system
    const connector = await buildConnectorFromProvider(providerId)
    if (connector) {
      const result = await connector.testConnection()
      await recordProviderHealth(providerId, result.success, result.error?.message)
      if (result.success) {
        await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PROVIDER_CONNECTION_TESTED', entity: 'Provider', entityId: provider.code, details: `${provider.name}: ${result.data?.message || 'Connection successful'}` } })
        return { success: true, message: result.data?.message || 'Connection successful' }
      }
      return { success: false, error: result.error?.message || 'Connection test failed' }
    }

    // Fall back to legacy adapter
    const adapter = await buildAdapter(provider)
    if (adapter) {
      const result = await adapter.testConnection()
      await recordProviderHealth(providerId, result.success, result.error?.message)
      if (result.success) {
        await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PROVIDER_CONNECTION_TESTED', entity: 'Provider', entityId: provider.code, details: `${provider.name}: ${result.data?.message || 'Connection successful'} (LegacyAdapter: ${adapter.name})` } })
        return { success: true, message: `${result.data?.message || 'Connection successful'} | Runtime: LegacyAdapter (${adapter.name})` }
      }
      return { success: false, error: result.error?.message || 'Connection test failed' }
    }
  } catch (e: any) {
    await recordProviderHealth(providerId, false, e.message)
    return { success: false, error: e.message || 'Connection test failed' }
  }

  return { success: false, error: 'No adapter available for provider' }
}

export async function setProviderStatus(providerId: string, status: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const validStatuses = ['ACTIVE', 'DEGRADED', 'MAINTENANCE', 'INACTIVE', 'TESTING', 'ARCHIVED']
  if (!validStatuses.includes(status)) return { success: false, error: 'Invalid status' }

  await prisma.provider.update({ where: { id: providerId }, data: { status: status as any } })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_STATUS_CHANGED', entity: 'Provider', entityId: providerId, details: `Provider status manually set to ${status}` },
  })

  revalidatePath('/admin/providers')
  revalidatePath(`/admin/providers/${providerId}`)
  return { success: true }
}
