'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { IbasisConnector } from '@/lib/providers/connectors/ibasis-connector'
import { maskIccid } from '@/lib/providers/mappers/ibasis-sim-mapper'
import {
  canTransitionSubscriptionStatus,
  sanitizeSubscriptionMetadata,
} from '@/lib/providers/mappers/ibasis-subscription-mapper'

function isIbasisConnector(c: unknown): c is IbasisConnector {
  return c !== null && typeof c === 'object' && 'getSubscription' in c && 'getActivationStatus' in c
}

export interface SyncSubscriptionStatusInput {
  providerId: string
  providerSubscriptionId?: string
  providerActivationId?: string
  /** Explicitly allowed status transitions (from, to) — overrides terminal-state protection. */
  allowedTransitions?: Array<[string, string]>
  force?: boolean
}

interface FetchedProviderState {
  status: string
  providerStatus: string
  providerSubscriptionId: string | null
  providerActivationId: string | null
  subscriberId: string | null
  iccid: string | null
  msisdn: string | null
  planId: string | null
  sanitizedRaw: Record<string, unknown>
}

async function fetchProviderState(connector: IbasisConnector, input: SyncSubscriptionStatusInput): Promise<{ state: FetchedProviderState | null; error?: string }> {
  if (input.providerSubscriptionId) {
    const res = await connector.getSubscription(input.providerSubscriptionId)
    if (!res.success) return { state: null, error: res.error?.message || 'Failed to fetch subscription' }
    const sub = res.data!
    return {
      state: {
        status: sub.status,
        providerStatus: sub.providerStatus,
        providerSubscriptionId: sub.providerSubscriptionId,
        providerActivationId: null,
        subscriberId: sub.subscriberId,
        iccid: sub.iccid,
        msisdn: sub.msisdn,
        planId: sub.planId,
        sanitizedRaw: sanitizeSubscriptionMetadata(sub.rawData),
      },
    }
  }

  if (input.providerActivationId) {
    const res = await connector.getActivationStatus(input.providerActivationId)
    if (!res.success) return { state: null, error: res.error?.message || 'Failed to fetch activation status' }
    const activation = res.data!

    // Once activation completes, iBASIS returns a subscription id — fetch full detail for richer state.
    if (activation.providerSubscriptionId) {
      const detail = await connector.getSubscription(activation.providerSubscriptionId)
      if (detail.success) {
        const sub = detail.data!
        return {
          state: {
            status: sub.status,
            providerStatus: sub.providerStatus,
            providerSubscriptionId: sub.providerSubscriptionId,
            providerActivationId: input.providerActivationId,
            subscriberId: sub.subscriberId,
            iccid: sub.iccid,
            msisdn: sub.msisdn,
            planId: sub.planId,
            sanitizedRaw: sanitizeSubscriptionMetadata(sub.rawData),
          },
        }
      }
    }

    return {
      state: {
        status: activation.status,
        providerStatus: activation.providerStatus,
        providerSubscriptionId: activation.providerSubscriptionId,
        providerActivationId: input.providerActivationId,
        subscriberId: null,
        iccid: null,
        msisdn: null,
        planId: null,
        sanitizedRaw: sanitizeSubscriptionMetadata({ status: activation.providerStatus }),
      },
    }
  }

  return { state: null, error: 'providerSubscriptionId or providerActivationId is required' }
}

/**
 * Fetches the latest iBASIS subscription state, normalizes the status, and
 * updates the local subscription (ESIM) — preserving audit history and never
 * regressing terminal states (EXPIRED/CANCELLED) unless explicitly allowed.
 *
 * Persists: providerSubscriptionId, providerSubscriberId, lastProviderStatus,
 * lastStatusSync, providerMetadata (sanitized). Business data is never overwritten.
 */
export async function syncSubscriptionStatus(input: SyncSubscriptionStatusInput) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const provider = await prisma.provider.findUnique({ where: { id: input.providerId } })
  if (!provider) return { error: 'Provider not found' }
  const connector = await buildConnectorFromProvider(input.providerId)
  if (!connector || !isIbasisConnector(connector)) return { error: 'Provider does not support iBASIS subscription sync' }

  const { state, error } = await fetchProviderState(connector, input)
  if (!state) return { error: error || 'Failed to fetch provider state' }

  // Locate the local subscription by either provider reference.
  const local = input.providerSubscriptionId
    ? await prisma.eSIM.findFirst({ where: { providerSubscriptionId: input.providerSubscriptionId } })
    : input.providerActivationId
      ? await prisma.eSIM.findFirst({ where: { providerActivationId: input.providerActivationId } })
      : null

  if (!local) {
    return {
      success: true,
      status: 'NO_LOCAL_RECORD',
      result: {
        fetchedStatus: state.status,
        providerStatus: state.providerStatus,
        providerSubscriptionId: state.providerSubscriptionId,
        reason: 'No local subscription matches the provider reference — nothing persisted',
      },
    }
  }

  // Terminal-state protection: never regress unless explicitly allowed.
  if (!canTransitionSubscriptionStatus(local.status, state.status, {
    allowedTransitions: input.allowedTransitions,
    force: input.force,
  })) {
    return {
      success: true,
      skipped: true,
      reason: `Blocked status regression ${local.status} → ${state.status} (terminal state)`,
      result: { currentStatus: local.status, fetchedStatus: state.status },
    }
  }

  const now = new Date()
  const prevProviderResponse = (local.providerResponse as Record<string, unknown> | null) || {}
  const history = Array.isArray(prevProviderResponse.__statusHistory)
    ? [...(prevProviderResponse.__statusHistory as unknown[])]
    : []
  history.push({
    from: local.status,
    to: state.status,
    providerStatus: state.providerStatus,
    at: now.toISOString(),
  })

  // Persist provider linkage + status only — business data is left untouched.
  await prisma.eSIM.update({
    where: { id: local.id },
    data: {
      status: state.status,
      providerStatus: state.providerStatus,
      lastStatusSyncAt: now,
      ...(local.providerSubscriptionId ? {} : { providerSubscriptionId: state.providerSubscriptionId || undefined }),
      ...(local.providerActivationId ? {} : { providerActivationId: state.providerActivationId || undefined }),
      ...(local.providerSubscriberId ? {} : { providerSubscriberId: state.subscriberId || undefined }),
      providerResponse: {
        ...state.sanitizedRaw,
        __syncSig: state.status,
        __statusHistory: history,
      } as any,
    },
  })

  console.log(`[IBASIS_SUBSCRIPTION_SYNC] provider=${provider.code} esimId=${local.id} status=${local.status}->${state.status} providerStatus=${state.providerStatus}`)

  const { emitEvent } = await import('@/lib/catalog-events')
  emitEvent({
    eventType: local.status !== state.status ? 'SIM_STATUS_CHANGED' : 'SIM_UPDATED',
    providerId: provider.id,
    providerCode: provider.code,
    packageId: null,
    comparableKey: null,
    changedFields: local.status !== state.status ? ['status'] : [],
    trigger: 'USER_ACTION',
    userId: session.user.id,
    metadata: {
      iccid: local.iccid ? maskIccid(local.iccid) : null,
      oldStatus: local.status,
      newStatus: state.status,
      providerStatus: state.providerStatus,
      providerSubscriptionId: state.providerSubscriptionId,
    },
  })

  return {
    success: true,
    status: 'SYNCED',
    result: {
      esimId: local.id,
      oldStatus: local.status,
      newStatus: state.status,
      providerStatus: state.providerStatus,
      providerSubscriptionId: state.providerSubscriptionId || local.providerSubscriptionId || null,
      lastStatusSync: now,
    },
  }
}
