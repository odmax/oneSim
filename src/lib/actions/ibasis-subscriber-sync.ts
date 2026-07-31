'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { IbasisConnector } from '@/lib/providers/connectors/ibasis-connector'
import type { IbasisSubscriberInput } from '@/lib/providers/mappers/ibasis-subscriber-mapper'

function isIbasisConnector(c: unknown): c is IbasisConnector {
  return c !== null && typeof c === 'object' && 'createSubscriber' in c && 'searchSubscribers' in c
}

/** Only subscriber linkage metadata is written back to the local Customer — business data is never overwritten. */
function buildCustomerProviderMetadata(mapped: { rawData: Record<string, unknown> }): Record<string, unknown> {
  return {
    subscriber: mapped.rawData,
    syncedAt: new Date().toISOString(),
  }
}

async function getConnector(providerId: string) {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return null
  const connector = await buildConnectorFromProvider(providerId)
  if (!connector || !isIbasisConnector(connector)) return null
  return connector
}

async function upsertLocalCustomer(businessId: string, providerSubscriberId: string, mapped: { firstName: string | null; lastName: string | null; username: string; email: string | null; phone: string | null; rawData: Record<string, unknown> }) {
  const name = [mapped.firstName, mapped.lastName].filter(Boolean).join(' ') || mapped.username || 'iBASIS Subscriber'
  const email = mapped.email || mapped.username || `${providerSubscriberId}@subscriber.local`
  const metadata = buildCustomerProviderMetadata(mapped)

  let customer = await prisma.customer.findFirst({
    where: { businessId, providerSubscriberId },
  })

  if (customer) {
    // Preserve business data — only refresh provider linkage fields.
    return await prisma.customer.update({
      where: { id: customer.id },
      data: { providerMetadata: metadata as any },
    })
  }

  return await prisma.customer.create({
    data: {
      businessId,
      name,
      email,
      phone: mapped.phone || undefined,
      country: 'XX',
      providerSubscriberId,
      providerMetadata: metadata as any,
    },
  })
}

/**
 * Ensures an iBASIS subscriber exists (deduped at the provider level) and is
 * mirrored into a local Customer keyed by the provider subscriber ID.
 *
 * Duplicate customers are never created — an existing Customer with the same
 * providerSubscriberId is reused.
 */
export async function ensureIbasisSubscriber(providerId: string, businessId: string, input: IbasisSubscriberInput) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  if (!providerId || !businessId) return { error: 'providerId and businessId are required' }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }
  const connector = await getConnector(providerId)
  if (!connector) return { error: 'Provider does not support iBASIS subscriber sync' }

  try {
    // 1. Dedupe at the provider level — search by username/email first.
    const searchResult = await connector.searchSubscribers({ username: input.username, email: input.email })
    if (!searchResult.success) return { error: `Failed to search subscribers: ${searchResult.error?.message}` }

    let providerSubscriberId: string | null = null
    if (searchResult.data?.items?.length) {
      providerSubscriberId = searchResult.data.items[0]
    } else {
      const createResult = await connector.createSubscriber(input)
      if (!createResult.success) return { error: `Failed to create subscriber: ${createResult.error?.message}` }
      providerSubscriberId = createResult.data!.providerSubscriberId
    }

    // 2. Fetch the authoritative subscriber detail.
    const detailResult = await connector.getSubscriber(providerSubscriberId)
    if (!detailResult.success) return { error: `Failed to fetch subscriber: ${detailResult.error?.message}` }
    const mapped = detailResult.data!

    // 3. Upsert local Customer by provider subscriber ID — never duplicate.
    const customer = await upsertLocalCustomer(businessId, providerSubscriberId, mapped)

    console.log(`[IBASIS_SUBSCRIBER] provider=${provider.code} providerSubscriberId=${providerSubscriberId} customerId=${customer.id}`)

    return {
      success: true,
      result: {
        providerSubscriberId,
        customerId: customer.id,
        email: mapped.email || mapped.username,
        name: [mapped.firstName, mapped.lastName].filter(Boolean).join(' ') || mapped.username,
      },
    }
  } catch (error: any) {
    return { error: `Subscriber sync failed: ${error.message || 'Unknown error'}` }
  }
}

/** Fetches an iBASIS subscriber and mirrors provider linkage fields onto the matching local Customer. */
export async function getIbasisSubscriber(providerId: string, businessId: string, providerSubscriberId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }
  const connector = await getConnector(providerId)
  if (!connector) return { error: 'Provider does not support iBASIS subscriber sync' }

  const result = await connector.getSubscriber(providerSubscriberId)
  if (!result.success) return { error: result.error?.message || 'Failed to fetch subscriber' }
  const mapped = result.data!
  const customer = await upsertLocalCustomer(businessId, providerSubscriberId, mapped)

  return {
    success: true,
    result: {
      providerSubscriberId,
      customerId: customer.id,
      firstName: mapped.firstName,
      lastName: mapped.lastName,
      email: mapped.email,
      phone: mapped.phone,
    },
  }
}

/** Updates a subscriber on iBASIS, then mirrors linkage fields back to the local Customer. */
export async function updateIbasisSubscriber(providerId: string, businessId: string, providerSubscriberId: string, patch: IbasisSubscriberInput) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }
  const connector = await getConnector(providerId)
  if (!connector) return { error: 'Provider does not support iBASIS subscriber sync' }

  const result = await connector.updateSubscriber(providerSubscriberId, patch)
  if (!result.success) return { error: result.error?.message || 'Failed to update subscriber' }
  const mapped = result.data!
  const customer = await upsertLocalCustomer(businessId, providerSubscriberId, mapped)

  return {
    success: true,
    result: { providerSubscriberId, customerId: customer.id, updated: true },
  }
}
