'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { generateApiKey, hashApiKey } from '@/lib/api/auth'
import { handlePrismaError } from '@/lib/errors/handle-prisma-error'

export async function createApiKey(name: string, options?: { scopes?: string[]; expiresInDays?: number; environment?: string }) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

    const businessUser = await prisma.businessUser.findFirst({
      where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
    })
    if (!businessUser) return { error: 'Only Business Admins can create API keys' }

    const { raw, prefix, hash } = generateApiKey()
    const expiresAt = options?.expiresInDays ? new Date(Date.now() + options.expiresInDays * 86400000) : undefined

    await prisma.businessApiKey.create({
      data: {
        businessId: session.user.businessId!, name, keyHash: hash, keyPrefix: prefix,
        scopes: options?.scopes || [],
        expiresAt,
        environment: options?.environment || 'production',
      },
    })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'API_KEY_CREATED', entity: 'BusinessApiKey', entityId: prefix, details: `API key "${name}" created (prefix: ${prefix}), scopes: ${(options?.scopes || []).join(', ') || 'full access'}` },
    })

    revalidatePath('/business/api-keys')
    return { raw, prefix, name }
  } catch (error: any) {
    const { message } = handlePrismaError(error, 'Failed to create API key')
    return { error: message }
  }
}

export async function rotateApiKey(keyId: string, gracePeriodDays?: number) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

    const businessUser = await prisma.businessUser.findFirst({
      where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
    })
    if (!businessUser) return { error: 'Only Business Admins can rotate API keys' }

    const oldKey = await prisma.businessApiKey.findFirst({ where: { id: keyId, businessId: session.user.businessId! } })
    if (!oldKey) return { error: 'API key not found' }

    const { raw, prefix, hash } = generateApiKey()
    const newKey = await prisma.businessApiKey.create({
      data: {
        businessId: session.user.businessId!, name: `${oldKey.name} (rotated)`, keyHash: hash, keyPrefix: prefix,
        scopes: oldKey.scopes, environment: oldKey.environment,
      },
    })

    const graceEnd = gracePeriodDays ? new Date(Date.now() + gracePeriodDays * 86400000) : undefined
    await prisma.businessApiKey.update({
      where: { id: keyId },
      data: { replacedById: newKey.id, rotatedAt: new Date(), gracePeriodEndAt: graceEnd },
    })
    if (!gracePeriodDays) {
      await prisma.businessApiKey.update({ where: { id: keyId }, data: { status: 'REVOKED' } })
    }

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'API_KEY_ROTATED', entity: 'BusinessApiKey', entityId: oldKey.keyPrefix, details: `Key "${oldKey.name}" rotated (new prefix: ${prefix}), grace: ${gracePeriodDays ?? 'immediate'}d` },
    })

    revalidatePath('/business/api-keys')
    return { raw, prefix, name: newKey.name }
  } catch (error: any) {
    const { message } = handlePrismaError(error, 'Failed to rotate API key')
    return { error: message }
  }
}

export async function revokeApiKey(keyId: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') { redirect('/login') }

    const businessUser = await prisma.businessUser.findFirst({
      where: { userId: session.user.id, businessId: session.user.businessId!, role: 'ADMIN' },
    })
    if (!businessUser) return { error: 'Only Business Admins can revoke API keys' }

    const key = await prisma.businessApiKey.findFirst({ where: { id: keyId, businessId: session.user.businessId! } })
    if (!key) return { error: 'API key not found' }
    if (key.status === 'REVOKED') return { error: 'API key is already revoked' }

    await prisma.businessApiKey.update({ where: { id: keyId }, data: { status: 'REVOKED' } })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'API_KEY_REVOKED', entity: 'BusinessApiKey', entityId: key.keyPrefix, details: `API key "${key.name}" revoked` },
    })

    revalidatePath('/business/api-keys')
    return { success: true }
  } catch (error: any) {
    const { message } = handlePrismaError(error, 'Failed to revoke API key')
    return { error: message }
  }
}

export async function listApiKeys() {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const keys = await prisma.businessApiKey.findMany({
    where: { businessId: session.user.businessId! },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, keyPrefix: true, status: true,
      lastUsedAt: true, createdAt: true, expiresAt: true,
      scopes: true, environment: true, replacedById: true, rotatedAt: true,
    },
  })

  return keys
}
