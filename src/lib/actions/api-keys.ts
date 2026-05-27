'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { generateApiKey, hashApiKey } from '@/lib/api/auth'

export async function createApiKey(name: string) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const businessUser = await prisma.businessUser.findFirst({
    where: {
      userId: session.user.id,
      businessId: session.user.businessId!,
      role: 'ADMIN',
    },
  })

  if (!businessUser) {
    return { error: 'Only Business Admins can create API keys' }
  }

  const { raw, prefix, hash } = generateApiKey()

  await prisma.businessApiKey.create({
    data: {
      businessId: session.user.businessId!,
      name,
      keyHash: hash,
      keyPrefix: prefix,
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'API_KEY_CREATED',
      entity: 'BusinessApiKey',
      entityId: prefix,
      details: `API key "${name}" created (prefix: ${prefix})`,
    },
  })

  revalidatePath('/business/api-keys')

  return { raw, prefix, name }
}

export async function revokeApiKey(keyId: string) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const businessUser = await prisma.businessUser.findFirst({
    where: {
      userId: session.user.id,
      businessId: session.user.businessId!,
      role: 'ADMIN',
    },
  })

  if (!businessUser) {
    return { error: 'Only Business Admins can revoke API keys' }
  }

  const key = await prisma.businessApiKey.findFirst({
    where: {
      id: keyId,
      businessId: session.user.businessId!,
    },
  })

  if (!key) {
    return { error: 'API key not found' }
  }

  if (key.status === 'REVOKED') {
    return { error: 'API key is already revoked' }
  }

  await prisma.businessApiKey.update({
    where: { id: keyId },
    data: { status: 'REVOKED' },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'API_KEY_REVOKED',
      entity: 'BusinessApiKey',
      entityId: key.keyPrefix,
      details: `API key "${key.name}" revoked`,
    },
  })

  revalidatePath('/business/api-keys')
  return { success: true }
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
      id: true,
      name: true,
      keyPrefix: true,
      status: true,
      lastUsedAt: true,
      createdAt: true,
    },
  })

  return keys
}
