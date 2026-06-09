'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function getTemplates() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return []
  return prisma.providerTemplate.findMany({ orderBy: { name: 'asc' } })
}

export async function getTemplate(id: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return null
  return prisma.providerTemplate.findUnique({ where: { id } })
}

export async function createTemplate(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const name = formData.get('name') as string
  if (!name) redirect('/admin/provider-templates/new?error=Name+is+required')

  const template = await prisma.providerTemplate.create({
    data: {
      name,
      description: (formData.get('description') as string) || null,
      connectorType: (formData.get('connectorType') as string) || 'STANDARD',
      authType: (formData.get('authType') as string) || 'bearer_token',
      tokenPlacement: (formData.get('tokenPlacement') as string) || 'URL_PATH',
      defaultBaseUrl: (formData.get('defaultBaseUrl') as string) || null,
      defaultAuthUrl: (formData.get('defaultAuthUrl') as string) || null,
      defaultPlanListPath: (formData.get('defaultPlanListPath') as string) || null,
      defaultActivationPath: (formData.get('defaultActivationPath') as string) || null,
      defaultStatusPath: (formData.get('defaultStatusPath') as string) || null,
      defaultUsagePath: (formData.get('defaultUsagePath') as string) || null,
      defaultSuspendPath: (formData.get('defaultSuspendPath') as string) || null,
      defaultResumePath: (formData.get('defaultResumePath') as string) || null,
      defaultResponseListKey: (formData.get('defaultResponseListKey') as string) || null,
      defaultFieldMappings: parseJsonField(formData, 'defaultFieldMappings', {}),
      defaultCapabilities: parseJsonField(formData, 'defaultCapabilities', {}),
      endpointMappings: parseJsonField(formData, 'endpointMappings', null),
      isSystemTemplate: formData.get('isSystemTemplate') === 'on',
      createdBy: session.user.id,
    },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_TEMPLATE_CREATED', entity: 'ProviderTemplate', entityId: template.id, details: `Template "${name}" created` },
  })

  revalidatePath('/admin/provider-templates')
  redirect('/admin/provider-templates')
}

export async function updateTemplate(templateId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const name = formData.get('name') as string
  if (!name) redirect(`/admin/provider-templates/${templateId}/edit?error=Name+is+required`)

  const template = await prisma.providerTemplate.update({
    where: { id: templateId },
    data: {
      name,
      description: (formData.get('description') as string) || null,
      connectorType: (formData.get('connectorType') as string) || 'STANDARD',
      authType: (formData.get('authType') as string) || 'bearer_token',
      tokenPlacement: (formData.get('tokenPlacement') as string) || 'URL_PATH',
      defaultBaseUrl: (formData.get('defaultBaseUrl') as string) || null,
      defaultAuthUrl: (formData.get('defaultAuthUrl') as string) || null,
      defaultPlanListPath: (formData.get('defaultPlanListPath') as string) || null,
      defaultActivationPath: (formData.get('defaultActivationPath') as string) || null,
      defaultStatusPath: (formData.get('defaultStatusPath') as string) || null,
      defaultUsagePath: (formData.get('defaultUsagePath') as string) || null,
      defaultSuspendPath: (formData.get('defaultSuspendPath') as string) || null,
      defaultResumePath: (formData.get('defaultResumePath') as string) || null,
      defaultResponseListKey: (formData.get('defaultResponseListKey') as string) || null,
      defaultFieldMappings: parseJsonField(formData, 'defaultFieldMappings', {}),
      defaultCapabilities: parseJsonField(formData, 'defaultCapabilities', {}),
      endpointMappings: parseJsonField(formData, 'endpointMappings', null),
    },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_TEMPLATE_UPDATED', entity: 'ProviderTemplate', entityId: template.id, details: `Template "${name}" updated` },
  })

  revalidatePath('/admin/provider-templates')
  redirect('/admin/provider-templates')
}

export async function deleteTemplate(templateId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const template = await prisma.providerTemplate.findUnique({ where: { id: templateId } })
  if (!template) return { success: false, error: 'Template not found' }

  await prisma.providerTemplate.delete({ where: { id: templateId } })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_TEMPLATE_DELETED', entity: 'ProviderTemplate', entityId: templateId, details: `Template "${template.name}" deleted` },
  })

  revalidatePath('/admin/provider-templates')
  return { success: true }
}

export async function deleteTemplateAction(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const templateId = formData.get('id') as string
  if (!templateId) return

  const template = await prisma.providerTemplate.findUnique({ where: { id: templateId } })
  if (!template) return

  await prisma.providerTemplate.delete({ where: { id: templateId } })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_TEMPLATE_DELETED', entity: 'ProviderTemplate', entityId: templateId, details: `Template "${template.name}" deleted` },
  })

  revalidatePath('/admin/provider-templates')
}

export async function saveProviderAsTemplate(providerId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  const name = formData.get('name') as string || `${provider.name} Template`

  const template = await prisma.providerTemplate.create({
    data: {
      name,
      description: (formData.get('description') as string) || `Template created from ${provider.name}`,
      connectorType: provider.adapterStrategy || 'STANDARD',
      authType: provider.authType || 'bearer_token',
      tokenPlacement: provider.tokenPlacement || 'URL_PATH',
      defaultBaseUrl: provider.apiBaseUrl,
      defaultAuthUrl: provider.authUrl,
      defaultPlanListPath: provider.planListPath,
      defaultActivationPath: provider.activationPath,
      defaultStatusPath: provider.statusPath,
      defaultUsagePath: provider.usagePath,
      defaultSuspendPath: provider.suspendPath,
      defaultResumePath: provider.resumePath,
      defaultResponseListKey: provider.responseListKey,
      defaultFieldMappings: (provider.fieldMappings as any) || {},
      defaultCapabilities: {
        supportsESIM: provider.supportsESIM,
        supportsUsage: provider.supportsUsage,
        supportsTopUp: provider.supportsTopUp,
        supportsSuspend: provider.supportsSuspend,
        supportsQRCode: provider.supportsQRCode,
        supportsPools: provider.supportsPools,
        supportsTemplates: provider.supportsTemplates,
        supportsUsageSync: provider.supportsUsageSync,
        supportsWebhookPush: provider.supportsWebhookPush,
        supportsSuspendResume: provider.supportsSuspendResume,
      },
      endpointMappings: provider.endpointMappings as any,
      isSystemTemplate: false,
      createdBy: session.user.id,
    },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_TEMPLATE_CREATED', entity: 'ProviderTemplate', entityId: template.id, details: `Template "${name}" created from provider "${provider.name}"` },
  })

  revalidatePath('/admin/provider-templates')
  return { success: true, templateId: template.id }
}

function parseJsonField(formData: FormData, key: string, fallback: any): any {
  const raw = formData.get(key)
  if (!raw) return fallback
  try { return JSON.parse(raw as string) } catch { return fallback }
}
