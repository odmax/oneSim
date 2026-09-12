import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerWebhookEvent: { findUnique: vi.fn(), update: vi.fn() },
    eSIM: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    usageRecord: { create: vi.fn() },
  },
}))

const { prisma } = await import('@/lib/prisma')
const { processProviderWebhookEvent, webhookLifecycleClaim } = await import('./provider-webhook-processor')

const mockPrisma = vi.mocked(prisma)

function makeEvent(overrides: any = {}) {
  return {
    id: 'evt-1',
    providerType: 'CHOICE',
    eventType: 'RECEIVED',
    status: 'RECEIVED',
    externalEventId: 'evt-1',
    iccid: null,
    imsi: null,
    esimId: 'esim-1',
    businessId: 'biz-1',
    errorMessage: null,
    receivedAt: new Date(),
    processedAt: null,
    payload: { body: { command: 'imsi_usage_threshold_notice', threshold_code: '1', quantity_used: 25, max_qty_type: 'MB', imsi: '310150123456789', start_time: '2026-08-01-00.00.00' } },
    ...overrides,
  }
}

function makeEsim(overrides: any = {}) {
  return {
    id: 'esim-1',
    iccid: '89012345678901234567',
    status: 'PENDING_ACTIVATION',
    providerStatus: null,
    dataUsedMB: 0,
    activatedAt: null,
    activationDetectedAt: null,
    providerResponse: null,
    lastUsageAt: null,
    expiresAt: null,
    ...overrides,
  }
}

async function process(event: any, esim: any) {
  mockPrisma.providerWebhookEvent.findUnique.mockResolvedValue(event as any)
  if (event.esimId) mockPrisma.eSIM.findUnique.mockResolvedValue(esim as any)
  mockPrisma.providerWebhookEvent.update.mockResolvedValue({} as any)
  mockPrisma.eSIM.update.mockResolvedValue({} as any)
  const result = await processProviderWebhookEvent(event.id)
  return result
}

function lastEsimUpdate() {
  return mockPrisma.eSIM.update.mock.calls[0][0].data
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('webhookLifecycleClaim', () => {
  it('maps lifecycle events to canonical claims (ACTIVE is a claim, not evidence)', () => {
    expect(webhookLifecycleClaim('ESIM_ACTIVATED')).toBe('ACTIVE')
    expect(webhookLifecycleClaim('ESIM_RESUMED')).toBe('ACTIVE')
    expect(webhookLifecycleClaim('ESIM_EXPIRED')).toBe('EXPIRED')
    expect(webhookLifecycleClaim('ESIM_SUSPENDED')).toBe('SUSPENDED')
    expect(webhookLifecycleClaim('USAGE_UPDATED')).toBe('PENDING_ACTIVATION')
    expect(webhookLifecycleClaim('UNKNOWN')).toBe('PENDING_ACTIVATION')
  })
})

describe('processProviderWebhookEvent — canonical lifecycle arbitration (D1)', () => {
  it('1. PENDING_ACTIVATION + ACTIVE-like event WITHOUT evidence → stays PENDING_ACTIVATION', async () => {
    const event = makeEvent({ providerType: 'TELNA', payload: { body: { event: 'esim_activated', iccid: '8901', status: 'ACTIVE' } } })
    const result = await process(event, makeEsim())
    expect(result.status).toBe('PROCESSED')
    expect(mockPrisma.eSIM.update).toHaveBeenCalledTimes(1)
    expect(lastEsimUpdate().status).toBe('PENDING_ACTIVATION')
    expect(lastEsimUpdate().status).not.toBe('ACTIVE')
  })

  it('2. ACTIVE + ACTIVE event → stays ACTIVE (already-activated)', async () => {
    const event = makeEvent({ providerType: 'TELNA', payload: { body: { event: 'esim_activated', iccid: '8901', status: 'ACTIVE' } } })
    await process(event, makeEsim({ status: 'ACTIVE', activatedAt: new Date('2026-01-01') }))
    expect(lastEsimUpdate().status).toBe('ACTIVE')
  })

  it('3. EXPIRED + ESIM_ACTIVATED → EXPIRED preserved (no resurrection)', async () => {
    const event = makeEvent({ providerType: 'TELNA', payload: { body: { event: 'esim_activated', iccid: '8901', status: 'ACTIVE' } } })
    await process(event, makeEsim({ status: 'EXPIRED' }))
    expect(lastEsimUpdate().status).toBe('EXPIRED')
  })

  it('4. FAILED + ESIM_ACTIVATED → FAILED preserved (no resurrection)', async () => {
    const event = makeEvent({ providerType: 'TELNA', payload: { body: { event: 'esim_activated', iccid: '8901', status: 'ACTIVE' } } })
    await process(event, makeEsim({ status: 'FAILED' }))
    expect(lastEsimUpdate().status).toBe('FAILED')
  })

  it('5. CANCELLED + ESIM_ACTIVATED → CANCELLED preserved (no resurrection)', async () => {
    const event = makeEvent({ providerType: 'TELNA', payload: { body: { event: 'esim_activated', iccid: '8901', status: 'ACTIVE' } } })
    await process(event, makeEsim({ status: 'CANCELLED' }))
    expect(lastEsimUpdate().status).toBe('CANCELLED')
  })

  it('6. EXPIRED + ESIM_RESUMED → EXPIRED preserved', async () => {
    const event = makeEvent({ payload: { body: { command: 'imsi_resume', message: 'resumed', imsi: '310150123456789' } } })
    await process(event, makeEsim({ status: 'EXPIRED' }))
    expect(lastEsimUpdate().status).toBe('EXPIRED')
  })

  it('7. CANCELLED + ESIM_RESUMED → CANCELLED preserved', async () => {
    const event = makeEvent({ payload: { body: { command: 'imsi_resume', message: 'resumed', imsi: '310150123456789' } } })
    await process(event, makeEsim({ status: 'CANCELLED' }))
    expect(lastEsimUpdate().status).toBe('CANCELLED')
  })

  it('8. FAILED + ESIM_SUSPENDED → FAILED preserved', async () => {
    const event = makeEvent({ payload: { body: { command: 'imsi_suspend', imsi: '310150123456789' } } })
    await process(event, makeEsim({ status: 'FAILED' }))
    expect(lastEsimUpdate().status).toBe('FAILED')
  })

  it('9. SUSPENDED + weak ACTIVE claim WITHOUT activation evidence → SUSPENDED preserved (monotonic)', async () => {
    const event = makeEvent({ providerType: 'TELNA', payload: { body: { event: 'esim_activated', iccid: '8901', status: 'ACTIVE' } } })
    await process(event, makeEsim({ status: 'SUSPENDED' }))
    expect(lastEsimUpdate().status).toBe('SUSPENDED')
  })

  it('10. ACTIVE + weak event → ACTIVE preserved (claim without downgrade)', async () => {
    const event = makeEvent({ providerType: 'TELNA', payload: { body: { event: 'esim_activated', iccid: '8901', status: 'ACTIVE' } } })
    await process(event, makeEsim({ status: 'ACTIVE', activatedAt: new Date('2026-01-01') }))
    expect(lastEsimUpdate().status).toBe('ACTIVE')
  })

  it('11. ESIM_EXPIRED from a non-terminal current state → EXPIRED', async () => {
    const event = makeEvent({ payload: { body: { command: 'imsi_usage_threshold_notice', threshold_code: '7', imsi: '310150123456789', expire_time: '2026-08-01-00.00.00' } } })
    await process(event, makeEsim())
    expect(lastEsimUpdate().status).toBe('EXPIRED')
    expect(lastEsimUpdate().expiresAt).toBeInstanceOf(Date)
  })

  it('12. ESIM_SUSPENDED from ACTIVE → SUSPENDED', async () => {
    const event = makeEvent({ payload: { body: { command: 'imsi_suspend', imsi: '310150123456789' } } })
    await process(event, makeEsim({ status: 'ACTIVE', activatedAt: new Date('2026-01-01') }))
    expect(lastEsimUpdate().status).toBe('SUSPENDED')
  })

  it('13. valid resume from SUSPENDED with activation history → ACTIVE', async () => {
    const event = makeEvent({ payload: { body: { command: 'imsi_resume', message: 'resumed', imsi: '310150123456789' } } })
    await process(event, makeEsim({ status: 'SUSPENDED', activatedAt: new Date('2026-01-01') }))
    expect(lastEsimUpdate().status).toBe('ACTIVE')
  })

  it('15/16. iBASIS `completed` webhook does NOT make an unactivated eSIM ACTIVE', async () => {
    const event = makeEvent({
      providerType: 'IBASIS',
      payload: { body: { subscription_activation_id: 'act-1', subscription_id: 'sub-1', status: 'completed' } },
    })
    await process(event, makeEsim({ status: 'PENDING_ACTIVATION' }))
    expect(lastEsimUpdate().status).toBe('PENDING_ACTIVATION')
    expect(lastEsimUpdate().status).not.toBe('ACTIVE')
    expect(lastEsimUpdate().providerStatus).toBe('completed')
  })

  it('15b. iBASIS `completed` on an already-activated eSIM keeps ACTIVE (already-activated)', async () => {
    const event = makeEvent({
      providerType: 'IBASIS',
      payload: { body: { subscription_activation_id: 'act-1', subscription_id: 'sub-1', status: 'completed' } },
    })
    await process(event, makeEsim({ status: 'ACTIVE', activatedAt: new Date('2026-01-01') }))
    expect(lastEsimUpdate().status).toBe('ACTIVE')
  })

  it('Choice first-usage ESIM_ACTIVATED WITH genuine usage evidence → ACTIVE (legit activation)', async () => {
    const event = makeEvent() // threshold_code 1 + quantity_used 25 MB → real usage evidence
    await process(event, makeEsim())
    expect(lastEsimUpdate().status).toBe('ACTIVE')
    expect(lastEsimUpdate().activatedAt).toBeInstanceOf(Date)
    expect(lastEsimUpdate().activationDetectedAt).toBeInstanceOf(Date)
  })

  it('18. Choice first-usage event cannot resurrect an EXPIRED eSIM (terminal wins over usage)', async () => {
    const event = makeEvent() // usage 25 MB
    await process(event, makeEsim({ status: 'EXPIRED' }))
    expect(lastEsimUpdate().status).toBe('EXPIRED')
  })

  it('14. reprocessing an already-PROCESSED event is a no-op (idempotency, no lifecycle side effect)', async () => {
    const event = makeEvent({ status: 'PROCESSED' })
    mockPrisma.providerWebhookEvent.findUnique.mockResolvedValue(event as any)
    const result = await processProviderWebhookEvent(event.id)
    expect(result.status).toBe('PROCESSED')
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('20. event with no matching eSIM → IGNORED, no lifecycle write', async () => {
    const event = makeEvent({ esimId: null, iccid: null, imsi: null })
    mockPrisma.providerWebhookEvent.findUnique.mockResolvedValue(event as any)
    mockPrisma.eSIM.findFirst.mockResolvedValue(null)
    mockPrisma.providerWebhookEvent.update.mockResolvedValue({} as any)
    await processProviderWebhookEvent(event.id)
    expect(mockPrisma.eSIM.update).not.toHaveBeenCalled()
  })

  it('records the canonical engine evidence reason in providerResponse (audit trail)', async () => {
    const event = makeEvent({ providerType: 'IBASIS', payload: { body: { subscription_activation_id: 'act-1', subscription_id: 'sub-1', status: 'completed' } } })
    await process(event, makeEsim({ status: 'PENDING_ACTIVATION' }))
    expect(lastEsimUpdate().providerResponse).toMatchObject({ webhook: 'ESIM_ACTIVATED', evidence: 'provider-active-no-evidence' })
  })

  it('9/10/11. usage-threshold webhook (threshold_code 6, non-expiry) does NOT change lifecycle status', async () => {
    // Choice `imsi_usage_threshold_notice` codes 2-6 are usage thresholds;
    // only code 7 is the documented package-expiration notice. A code-6 event
    // (USAGE_UPDATED) must never move a stored state — ACTIVE / SUSPENDED /
    // PENDING_ACTIVATION all stay unchanged (no status field in the write).
    const event = makeEvent({ payload: { body: { command: 'imsi_usage_threshold_notice', threshold_code: 6, imsi: '310150123456789' } } })
    for (const status of ['ACTIVE', 'SUSPENDED', 'PENDING_ACTIVATION']) {
      vi.clearAllMocks()
      await process(event, makeEsim({ status }))
      expect(mockPrisma.eSIM.update).toHaveBeenCalledTimes(1)
      expect(lastEsimUpdate().status).toBeUndefined()
    }
  })
})