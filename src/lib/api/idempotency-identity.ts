/**
 * CANONICAL PURCHASE REQUEST IDENTITY (for idempotency key binding).
 *
 * Two requests with the same business + idempotency key are "the same logical
 * purchase" iff this normalized identity matches. It deliberately compares
 * ONLY what changes WHAT is purchased — not presentation metadata.
 *
 * Identity components (client-visible, as-provided):
 *  - canonical retail package identifier (resolved packageId)
 *  - quantity
 *  - travel/start date, as provided by the client (null when omitted).
 *
 * Customer/email/phone are EXCLUDED on purpose: they do not change what is
 * purchased, and including them would turn CRM metadata churn into a false
 * idempotency conflict. callbackUrl is transport metadata — excluded.
 */
import crypto from 'crypto'

export interface PurchaseIdentityInput {
  packageId?: string | null
  sku?: string | null
  packageCode?: string | null
  /** Canonical retail package id once resolved (preferred over raw identifiers). */
  resolvedPackageId?: string | null
  quantity?: number | null
  travelDate?: string | null
}

/** Deterministic sha256 of the canonical [packageId, quantity, travelDate]. */
export function canonicalPurchaseIdentity(input: PurchaseIdentityInput): string {
  const pkg = String(input.resolvedPackageId || input.packageId || input.sku || input.packageCode || '')
  const qty = Number.isFinite(Number(input.quantity)) ? Number(input.quantity) : 1
  const travel = typeof input.travelDate === 'string' && input.travelDate.trim() !== ''
    ? input.travelDate.trim()
    : null
  return crypto.createHash('sha256').update(JSON.stringify([pkg, qty, travel])).digest('hex')
}

/** Strip the private identity field from a stored idempotency-record response. */
export function stripIdempotencyIdentity(response: any): any {
  if (!response || typeof response !== 'object') return response
  if (Array.isArray(response)) return response.map(stripIdempotencyIdentity)
  const { __requestIdentity, ...rest } = response as Record<string, any>
  return rest
}

/** Whether a stored record carries a comparable identity. */
export function hasIdempotencyIdentity(response: any): boolean {
  return !!response && typeof response === 'object' && typeof response.__requestIdentity === 'string'
}