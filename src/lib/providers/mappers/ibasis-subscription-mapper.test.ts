import { describe, it, expect } from 'vitest'
import {
  normalizeSubscriptionStatus,
  isTerminalSubscriptionStatus,
  canTransitionSubscriptionStatus,
  mapIbasisSubscription,
  mapIbasisActivationStatus,
  sanitizeSubscriptionMetadata,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from './ibasis-subscription-mapper'

describe('normalizeSubscriptionStatus', () => {
  it('maps iBASIS activation statuses into the app lifecycle', () => {
    expect(normalizeSubscriptionStatus('scheduled')).toBe('PENDING')
    expect(normalizeSubscriptionStatus('pending')).toBe('PENDING')
    expect(normalizeSubscriptionStatus('activation pending')).toBe('PENDING')
    expect(normalizeSubscriptionStatus('activation_pending')).toBe('PENDING')
    expect(normalizeSubscriptionStatus('processing')).toBe('PROVISIONING')
    expect(normalizeSubscriptionStatus('reserved')).toBe('PROVISIONING')
    expect(normalizeSubscriptionStatus('completed')).toBe('READY_TO_INSTALL')
    expect(normalizeSubscriptionStatus('active')).toBe('ACTIVE')
    expect(normalizeSubscriptionStatus('suspended')).toBe('SUSPENDED')
    expect(normalizeSubscriptionStatus('deactivated')).toBe('EXPIRED')
    expect(normalizeSubscriptionStatus('expired')).toBe('EXPIRED')
    expect(normalizeSubscriptionStatus('rejected')).toBe('FAILED')
    expect(normalizeSubscriptionStatus('failed')).toBe('FAILED')
    expect(normalizeSubscriptionStatus('canceled')).toBe('CANCELLED')
    expect(normalizeSubscriptionStatus('cancelled')).toBe('CANCELLED')
  })

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(normalizeSubscriptionStatus('  Active ')).toBe('ACTIVE')
  })

  it('returns UNKNOWN for unmapped or missing statuses', () => {
    expect(normalizeSubscriptionStatus('weird-state')).toBe('UNKNOWN')
    expect(normalizeSubscriptionStatus(null)).toBe('UNKNOWN')
    expect(normalizeSubscriptionStatus(undefined)).toBe('UNKNOWN')
    expect(normalizeSubscriptionStatus('')).toBe('UNKNOWN')
  })
})

describe('terminal statuses', () => {
  it('treats EXPIRED and CANCELLED as terminal', () => {
    expect(TERMINAL_SUBSCRIPTION_STATUSES).toEqual(new Set(['EXPIRED', 'CANCELLED']))
    expect(isTerminalSubscriptionStatus('EXPIRED')).toBe(true)
    expect(isTerminalSubscriptionStatus('CANCELLED')).toBe(true)
    expect(isTerminalSubscriptionStatus('ACTIVE')).toBe(false)
    expect(isTerminalSubscriptionStatus('FAILED')).toBe(false)
  })

  it('never regresses terminal states unless explicitly allowed', () => {
    expect(canTransitionSubscriptionStatus('EXPIRED', 'ACTIVE')).toBe(false)
    expect(canTransitionSubscriptionStatus('CANCELLED', 'READY_TO_INSTALL')).toBe(false)
    expect(canTransitionSubscriptionStatus('ACTIVE', 'EXPIRED')).toBe(true)
  })

  it('allows same-status transitions', () => {
    expect(canTransitionSubscriptionStatus('ACTIVE', 'ACTIVE')).toBe(true)
    expect(canTransitionSubscriptionStatus('EXPIRED', 'EXPIRED')).toBe(true)
  })

  it('allows regression when force is set', () => {
    expect(canTransitionSubscriptionStatus('EXPIRED', 'ACTIVE', { force: true })).toBe(true)
  })

  it('allows regression when explicitly listed in allowedTransitions', () => {
    expect(canTransitionSubscriptionStatus('CANCELLED', 'ACTIVE', { allowedTransitions: [['CANCELLED', 'ACTIVE']] })).toBe(true)
  })

  it('keeps FAILED retryable', () => {
    expect(canTransitionSubscriptionStatus('FAILED', 'PENDING')).toBe(true)
    expect(canTransitionSubscriptionStatus('FAILED', 'ACTIVE')).toBe(true)
  })
})

describe('mapIbasisSubscription', () => {
  it('normalizes a raw subscription payload', () => {
    const mapped = mapIbasisSubscription({
      id: 'sub-1',
      subscriber: '42',
      plan: '1GB_TEST_PLAN',
      status: 'active',
      msisdn: '+15551234567',
      devices: [{ device: '89975111967191511974', type: 'iccid' }],
      created_at: '2026-07-01T00:00:00Z',
      activated_at: '2026-07-02T00:00:00Z',
      expires_at: '2026-08-01T00:00:00Z',
    })
    expect(mapped).not.toBeNull()
    expect(mapped!.providerSubscriptionId).toBe('sub-1')
    expect(mapped!.subscriberId).toBe('42')
    expect(mapped!.planId).toBe('1GB_TEST_PLAN')
    expect(mapped!.status).toBe('ACTIVE')
    expect(mapped!.providerStatus).toBe('active')
    expect(mapped!.iccid).toBe('89975111967191511974')
    expect(mapped!.msisdn).toBe('+15551234567')
    expect(mapped!.createdAt).toBe('2026-07-01T00:00:00Z')
    expect(mapped!.activatedAt).toBe('2026-07-02T00:00:00Z')
    expect(mapped!.expiresAt).toBe('2026-08-01T00:00:00Z')
  })

  it('falls back to top-level iccid when devices array is absent', () => {
    const mapped = mapIbasisSubscription({ id: 'sub-1', iccid: '89975111967191511974', status: 'active' })
    expect(mapped!.iccid).toBe('89975111967191511974')
  })

  it('reads subscription_id when id is absent', () => {
    const mapped = mapIbasisSubscription({ subscription_id: 'sub-2', status: 'suspended' })
    expect(mapped!.providerSubscriptionId).toBe('sub-2')
    expect(mapped!.status).toBe('SUSPENDED')
  })

  it('returns null when no id present', () => {
    expect(mapIbasisSubscription({ status: 'active' })).toBeNull()
    expect(mapIbasisSubscription(null)).toBeNull()
  })
})

describe('mapIbasisActivationStatus', () => {
  it('normalizes activation status and captures subscription id when complete', () => {
    const mapped = mapIbasisActivationStatus({ status: 'completed', subscription_id: 'sub-9' }, 'act-1')
    expect(mapped!.activationId).toBe('act-1')
    expect(mapped!.status).toBe('READY_TO_INSTALL')
    expect(mapped!.providerSubscriptionId).toBe('sub-9')
  })

  it('returns null subscription id while still processing', () => {
    const mapped = mapIbasisActivationStatus({ status: 'processing' }, 'act-2')
    expect(mapped!.status).toBe('PROVISIONING')
    expect(mapped!.providerSubscriptionId).toBeNull()
  })

  it('returns null for non-object payloads', () => {
    expect(mapIbasisActivationStatus(null, 'act-3')).toBeNull()
  })
})

describe('sanitizeSubscriptionMetadata', () => {
  it('strips SIM PIN/PUK and activation codes recursively', () => {
    const clean = sanitizeSubscriptionMetadata({
      status: 'active',
      pin1: '1234',
      puk1: '11112222',
      pin2: '4321',
      puk2: '22221111',
      activation_code: 'FKE: 0$CUST-SECRET.GDSB.NET$555',
      nested: { pin1: '0000', keep: 'yes' },
    })
    expect(clean.status).toBe('active')
    expect(clean.keep ?? clean.nested?.keep).toBe('yes')
    expect('pin1' in clean).toBe(false)
    expect('puk1' in clean).toBe(false)
    expect('activation_code' in clean).toBe(false)
    expect('pin1' in (clean.nested as Record<string, unknown>)).toBe(false)
  })

  it('keeps non-sensitive data and returns {} for null', () => {
    expect(sanitizeSubscriptionMetadata({ id: 'sub-1', plan: 'p1' })).toEqual({ id: 'sub-1', plan: 'p1' })
    expect(sanitizeSubscriptionMetadata(null)).toEqual({})
  })
})
