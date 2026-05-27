'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { encryptToken } from '@/lib/encryption'

export type AdaptiveProviderInput = {
  name: string
  code: string
  adapterStrategy: string
  environment: string
  apiBaseUrl: string
  authUrl?: string
  apiToken?: string
  authType: string
  tokenPlacement: string
  planListPath?: string
  responseListKey?: string
  fieldMappings: Record<string, string>
  activationPath?: string
  endpointMappings?: Record<string, { method?: string; path?: string; body?: any }>
  statusPath?: string
  usagePath?: string
  suspendPath?: string
  resumePath?: string
}

export async function saveAdaptiveProvider(input: AdaptiveProviderInput) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const existing = await prisma.provider.findUnique({ where: { code: input.code.toUpperCase() } })
  if (existing) return { success: false, error: `Provider code "${input.code.toUpperCase()}" already exists` }

  const regions = input.authUrl ? [input.authUrl.replace(/https?:\/\//, '').split('/')[0]] : []

  const provider = await prisma.provider.create({
    data: {
      name: input.name,
      code: input.code.toUpperCase(),
      type: 'CUSTOM',
      adapterStrategy: 'STANDARD',
      status: 'TESTING',
      authType: input.authType || 'bearer_token',
      apiBaseUrl: input.apiBaseUrl || null,
      authUrl: input.authUrl || null,
      apiToken: encryptToken(input.apiToken),
      tokenPlacement: input.tokenPlacement || 'HEADER',
      environment: input.environment || 'staging',
      planListPath: input.planListPath || null,
      activationPath: input.activationPath || null,
      statusPath: input.statusPath || null,
      usagePath: input.usagePath || null,
      suspendPath: input.suspendPath || null,
      resumePath: input.resumePath || null,
      responseListKey: input.responseListKey || null,
      fieldMappings: input.fieldMappings || {},
      endpointMappings: input.endpointMappings || {},
      config: { adaptiveSetup: true, createdAt: new Date().toISOString() },
      supportsESIM: !!input.activationPath,
      supportsUsage: !!input.usagePath,
      supportsSuspendResume: !!(input.suspendPath && input.resumePath),
    },
  })

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'PROVIDER_CREATED', entity: 'Provider', entityId: provider.code, details: `Adaptive provider "${input.name}" (${provider.code}) created` },
  })

  revalidatePath('/admin/providers')
  redirect(`/admin/providers/${provider.id}?setup=true&source=adaptive`)
}
