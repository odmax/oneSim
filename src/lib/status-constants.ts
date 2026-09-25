/**
 * Canonical status value sets and presentation metadata shared by the UI label
 * helpers, the API/OpenAPI contracts, and tests.
 *
 * Every value here must stay aligned with the authoritative domain sources:
 *  - eSIM lifecycle: src/lib/services/esims/lifecycle-status.ts
 *  - order lifecycle: src/lib/services/orders/order-state-machine.ts
 *  - top-up: prisma/schema.prisma (enum ESIMTopUpStatus)
 */

export type EsimStatusTone = 'success' | 'warn' | 'danger' | 'neutral'

export const ESIM_LIFECYCLE_STATUSES = [
  'PENDING',
  'PROCESSING',
  'RESERVED',
  'PENDING_ACTIVATION',
  'INSTALLING',
  'INSTALLED',
  'ACTIVE',
  'SUSPENDED',
  'DEPLETED',
  'EXPIRED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
] as const

export interface EsimStatusMeta {
  label: string
  tone: EsimStatusTone
}

/** Customer-safe label + visual tone for every canonical eSIM lifecycle status. */
export const ESIM_STATUS_META: Record<string, EsimStatusMeta> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  PENDING_ACTIVATION: { label: 'Provisioned', tone: 'warn' },
  INSTALLED: { label: 'Installed on device', tone: 'success' },
  PENDING: { label: 'Provisioning', tone: 'warn' },
  PROCESSING: { label: 'Provisioning', tone: 'warn' },
  RESERVED: { label: 'Reserved', tone: 'neutral' },
  INSTALLING: { label: 'Installing', tone: 'warn' },
  SUSPENDED: { label: 'Suspended', tone: 'warn' },
  DEPLETED: { label: 'Depleted', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'danger' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
  REFUNDED: { label: 'Refunded', tone: 'danger' },
}

/**
 * Persisted order statuses — the key set of the order state machine
 * (src/lib/services/orders/order-state-machine.ts ORDER_TRANSITIONS).
 */
export const ORDER_STATUSES = [
  'CREATED',
  'PAYMENT_RESERVED',
  'PENDING_PROVIDER',
  'PROVIDER_ACCEPTED',
  'RESERVED',
  'FULFILLING',
  'FULFILLED',
  'PARTIALLY_FULFILLED',
  'INSTALLING',
  'INSTALLED',
  'ACTIVE',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
  'REFUNDED',
  'PROVIDER_RECONCILIATION',
] as const

/**
 * Transient/legacy order statuses the public API may legitimately surface but
 * that are never written by the state machine:
 *  - PROCESSING — returned ONLY by POST /esims/order (and the legacy
 *    /api/esim/purchase) while dispatch is enqueued async; never persisted.
 *  - PENDING — the eSIMPurchase column default (legacy rows only).
 */
export const ORDER_NON_MACHINE_STATUSES = ['PROCESSING', 'PENDING'] as const

/** Every order status the public API contract accepts (machine + legacy/async). */
export const ORDER_API_STATUSES = [...ORDER_STATUSES, ...ORDER_NON_MACHINE_STATUSES] as const

/** Canonical top-up request statuses (prisma ESIMTopUpStatus). */
export const TOPUP_STATUSES = ['PENDING', 'PENDING_REVIEW', 'COMPLETED', 'FAILED'] as const