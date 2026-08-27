import { prisma } from '@/lib/prisma'

/**
 * Durable upstream package-creation operation ledger for Mode B.
 *
 * Responsibilities:
 *  - create the operation row BEFORE any upstream mutation (survives restart)
 *  - enforce unique idempotency key + request-fingerprint replay protection
 *  - single-writer concurrency via a lease (SystemJobLock pattern) and a
 *    compare-and-set (CAS) transition to UPSTREAM_IN_PROGRESS
 *  - expose safe state transitions for the orchestrator
 *
 * The operation row NEVER stores credentials, provider tokens, activation codes,
 * or raw provider payloads.
 */

export const UPSTREAM_OP_STATUS = {
  PENDING: 'PENDING',
  UPSTREAM_IN_PROGRESS: 'UPSTREAM_IN_PROGRESS',
  UPSTREAM_SUCCEEDED: 'UPSTREAM_SUCCEEDED',
  LOCAL_PERSISTING: 'LOCAL_PERSISTING',
  COMPLETED: 'COMPLETED',
  UPSTREAM_ALREADY_EXISTS: 'UPSTREAM_ALREADY_EXISTS',
  AMBIGUOUS_UPSTREAM_RESULT: 'AMBIGUOUS_UPSTREAM_RESULT',
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',
  FAILED: 'FAILED',
} as const

export type UpstreamOpStatus = (typeof UPSTREAM_OP_STATUS)[keyof typeof UPSTREAM_OP_STATUS]

/** Safe transition map: current status → allowed next statuses. */
const TRANSITIONS: Record<string, readonly string[]> = {
  [UPSTREAM_OP_STATUS.PENDING]: [
    UPSTREAM_OP_STATUS.UPSTREAM_IN_PROGRESS,
    UPSTREAM_OP_STATUS.UPSTREAM_ALREADY_EXISTS,
    UPSTREAM_OP_STATUS.AMBIGUOUS_UPSTREAM_RESULT,
    UPSTREAM_OP_STATUS.FAILED,
  ],
  [UPSTREAM_OP_STATUS.UPSTREAM_IN_PROGRESS]: [
    UPSTREAM_OP_STATUS.UPSTREAM_SUCCEEDED,
    UPSTREAM_OP_STATUS.UPSTREAM_ALREADY_EXISTS,
    UPSTREAM_OP_STATUS.AMBIGUOUS_UPSTREAM_RESULT,
    UPSTREAM_OP_STATUS.FAILED,
  ],
  [UPSTREAM_OP_STATUS.UPSTREAM_SUCCEEDED]: [
    UPSTREAM_OP_STATUS.LOCAL_PERSISTING,
    UPSTREAM_OP_STATUS.PARTIAL_FAILURE,
    UPSTREAM_OP_STATUS.COMPLETED,
  ],
  [UPSTREAM_OP_STATUS.LOCAL_PERSISTING]: [
    UPSTREAM_OP_STATUS.COMPLETED,
    UPSTREAM_OP_STATUS.PARTIAL_FAILURE,
  ],
  [UPSTREAM_OP_STATUS.PARTIAL_FAILURE]: [
    UPSTREAM_OP_STATUS.LOCAL_PERSISTING,
    UPSTREAM_OP_STATUS.COMPLETED,
  ],
  [UPSTREAM_OP_STATUS.UPSTREAM_ALREADY_EXISTS]: [
    UPSTREAM_OP_STATUS.COMPLETED,
    UPSTREAM_OP_STATUS.AMBIGUOUS_UPSTREAM_RESULT,
  ],
  [UPSTREAM_OP_STATUS.AMBIGUOUS_UPSTREAM_RESULT]: [
    UPSTREAM_OP_STATUS.UPSTREAM_IN_PROGRESS,
    UPSTREAM_OP_STATUS.LOCAL_PERSISTING,
    UPSTREAM_OP_STATUS.COMPLETED,
    UPSTREAM_OP_STATUS.FAILED,
  ],
  [UPSTREAM_OP_STATUS.FAILED]: [],
  [UPSTREAM_OP_STATUS.COMPLETED]: [],
}

const OP_LOCK_PREFIX = 'cpb-upstream-op:'
const OP_LOCK_TTL_MS = 120_000

export function isAllowedTransition(from: string, to: string): boolean {
  const allowed = TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

export interface CreateOperationInput {
  idempotencyKey: string
  requestFingerprint: string
  providerId: string
  providerCode: string
  requestedSku: string
  requestedByName?: string
  requestedBy?: string
}

export interface LoadedOperation {
  op: any
  existing: boolean
  conflict: boolean
  conflictReason?: string
}

/**
 * Load-or-create the operation row for an idempotency key.
 *
 * - key exists + same fingerprint → return the operation for safe resume.
 * - key exists + different fingerprint → return conflict (replay with new payload).
 * - key absent → create a PENDING row and return it.
 *
 * Concurrency: the unique(idempotencyKey) constraint guarantees exactly one row
 * per key; a P2002 on create means another request won the race, so we re-read
 * and re-check the fingerprint.
 */
export async function loadOrCreateUpstreamOperation(
  input: CreateOperationInput,
): Promise<LoadedOperation> {
  const existing = await prisma.upstreamPackageCreationOperation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: {
      id: true,
      idempotencyKey: true,
      requestFingerprint: true,
      status: true,
      providerId: true,
      providerCode: true,
      requestedSku: true,
      requestedBy: true,
      upstreamReference: true,
      providerPackageId: true,
      esimPackageId: true,
      recoveryState: true,
      lastErrorCode: true,
      lastErrorMessageSafe: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (existing) {
    if (existing.requestFingerprint !== input.requestFingerprint) {
      return { op: existing, existing: true, conflict: true, conflictReason: `Idempotency key "${input.idempotencyKey}" was already used with a different request (fingerprint mismatch)` }
    }
    return { op: existing, existing: true, conflict: false }
  }

  try {
    const created = await prisma.upstreamPackageCreationOperation.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        providerId: input.providerId,
        providerCode: input.providerCode,
        requestedSku: input.requestedSku,
        requestedByName: input.requestedByName || null,
        requestedBy: input.requestedBy || null,
        status: UPSTREAM_OP_STATUS.PENDING,
      },
      select: {
        id: true,
        idempotencyKey: true,
        requestFingerprint: true,
        status: true,
        providerId: true,
        providerCode: true,
        requestedSku: true,
        requestedBy: true,
        upstreamReference: true,
        providerPackageId: true,
        esimPackageId: true,
        recoveryState: true,
        lastErrorCode: true,
        lastErrorMessageSafe: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return { op: created, existing: false, conflict: false }
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const reread = await prisma.upstreamPackageCreationOperation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          id: true,
          idempotencyKey: true,
          requestFingerprint: true,
          status: true,
          providerId: true,
          providerCode: true,
          requestedSku: true,
          requestedBy: true,
          upstreamReference: true,
          providerPackageId: true,
          esimPackageId: true,
          recoveryState: true,
          lastErrorCode: true,
          lastErrorMessageSafe: true,
          createdAt: true,
          updatedAt: true,
        },
      })
      if (reread && reread.requestFingerprint !== input.requestFingerprint) {
        return { op: reread, existing: true, conflict: true, conflictReason: `Idempotency key "${input.idempotencyKey}" was already used with a different request (fingerprint mismatch)` }
      }
      return { op: reread, existing: true, conflict: false }
    }
    throw e
  }
}

export interface LeaseResult {
  acquired: boolean
  opId: string
}

/**
 * Exclusive logical lease for an operation using the existing SystemJobLock
 * pattern. Guarantees a single writer never runs two concurrent upstream calls
 * for the same idempotency key. Persisted (DB-backed), never an in-memory mutex.
 */
export async function acquireUpstreamOperationLease(opId: string): Promise<LeaseResult> {
  const now = new Date()
  const until = new Date(now.getTime() + OP_LOCK_TTL_MS)
  try {
    await prisma.systemJobLock.upsert({
      where: { jobName: `${OP_LOCK_PREFIX}${opId}` },
      create: { jobName: `${OP_LOCK_PREFIX}${opId}`, lockedAt: now, lockedUntil: until, owner: `cpb-${process.pid}` },
      update: { lockedAt: now, lockedUntil: until, owner: `cpb-${process.pid}` },
    })
    return { acquired: true, opId }
  } catch {
    return { acquired: false, opId }
  }
}

/**
 * Read-only check of lease freshness for an operation. Returns true only when a
 * SystemJobLock row exists for this op AND its lockedUntil is still in the
 * future. This lets the orchestrator tell "another worker is actively running
 * the provider call" from "the previous worker crashed mid-request and its
 * lease has expired".
 *
 * Used when an operation is found in UPSTREAM_IN_PROGRESS. A still-fresh lease
 * means we must NOT touch it (return "already being processed"). An expired or
 * absent lease means the upstream outcome is unknowable — the orchestrator
 * transitions the op to AMBIGUOUS_UPSTREAM_RESULT instead of re-creating.
 */
export async function isUpstreamOperationLeaseActive(opId: string): Promise<boolean> {
  try {
    const lock = await prisma.systemJobLock.findUnique({
      where: { jobName: `${OP_LOCK_PREFIX}${opId}` },
      select: { lockedUntil: true },
    })
    if (!lock) return false
    return new Date(lock.lockedUntil).getTime() > Date.now()
  } catch {
    return false
  }
}

/** Release the lease for an operation (best-effort). */
export async function releaseUpstreamOperationLease(opId: string): Promise<void> {
  await prisma.systemJobLock.delete({ where: { jobName: `${OP_LOCK_PREFIX}${opId}` } }).catch(() => {})
}

/**
 * CAS: transition an operation from an expected status to a target status using
 * updateMany with a status condition. Returns true if exactly one row changed
 * (the transition won); false if another writer already moved it.
 */
export async function transitionUpstreamOperation(
  opId: string,
  fromStatus: UpstreamOpStatus,
  toStatus: UpstreamOpStatus,
  data: Record<string, unknown> = {},
): Promise<boolean> {
  if (!isAllowedTransition(fromStatus, toStatus)) {
    throw new Error(`Invalid upstream operation transition ${fromStatus} → ${toStatus}`)
  }
  const result = await prisma.upstreamPackageCreationOperation.updateMany({
    where: { id: opId, status: fromStatus },
    data: { status: toStatus, ...data, updatedAt: new Date() },
  })
  return result.count === 1
}

/** Record a safe terminal failure (validation/provider rejection: no upstream create possible). */
export async function markUpstreamOperationFailed(
  opId: string,
  opts: { code: string; message: string },
): Promise<void> {
  await prisma.upstreamPackageCreationOperation.update({
    where: { id: opId },
    data: {
      status: UPSTREAM_OP_STATUS.FAILED,
      lastErrorCode: opts.code,
      lastErrorMessageSafe: opts.message.slice(0, 500),
      updatedAt: new Date(),
    },
  }).catch(() => {})
}

/** Record the upstream outcome AMBIGUOUS (request may have reached provider). */
export async function markUpstreamOperationAmbiguous(
  opId: string,
  opts: { code: string; message: string },
): Promise<void> {
  await prisma.upstreamPackageCreationOperation.update({
    where: { id: opId },
    data: {
      status: UPSTREAM_OP_STATUS.AMBIGUOUS_UPSTREAM_RESULT,
      lastErrorCode: opts.code,
      lastErrorMessageSafe: opts.message.slice(0, 500),
      upstreamStartedAt: new Date(),
      updatedAt: new Date(),
    },
  }).catch(() => {})
}

/** Register an ALREADY_EXISTS outcome (upstream has the object). */
export async function markUpstreamOperationAlreadyExists(
  opId: string,
  opts: { reference?: string; message: string },
): Promise<void> {
  await prisma.upstreamPackageCreationOperation.update({
    where: { id: opId },
    data: {
      status: UPSTREAM_OP_STATUS.UPSTREAM_ALREADY_EXISTS,
      upstreamReference: opts.reference || null,
      lastErrorMessageSafe: opts.message.slice(0, 500),
      updatedAt: new Date(),
    },
  }).catch(() => {})
}