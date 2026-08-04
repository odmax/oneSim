import { describe, it, expect } from 'vitest'
import { getEsimActionAvailability, getUsagePanelState, getEsimStatusLabel } from './esim-action-availability'
import type { EsimAvailabilityEsim, EsimAvailabilityProvider } from './esim-action-availability'

const CHOICE_ICCID = '89012345678901234567'

function provider(over: Partial<EsimAvailabilityProvider> & { code?: string; capabilities?: string[] } = {}): EsimAvailabilityProvider {
  return {
    id: 'p1',
    name: 'Test Provider',
    type: 'GENERIC',
    code: over.code ?? '',
    capabilities: over.capabilities,
    enabledCapabilities: over.enabledCapabilities,
    supportsTopUp: over.supportsTopUp ?? null,
    supportsQRCode: over.supportsQRCode ?? null,
  }
}

function esim(over: Partial<EsimAvailabilityEsim> = {}): EsimAvailabilityEsim {
  return {
    iccid: CHOICE_ICCID,
    imsi: null,
    activationCode: null,
    qrCodeUrl: null,
    providerResponse: null,
    providerActivationId: null,
    providerSubscriptionId: null,
    providerSubscriberId: null,
    dataTotalMB: null,
    dataRemainingMB: null,
    status: 'ACTIVE',
    ...over,
  }
}

function choiceEsim(over: Partial<EsimAvailabilityEsim> = {}) {
  return esim(over)
}

describe('getEsimActionAvailability — Choice', () => {
  const choice = provider({ code: 'CHOICE' })

  it('Choice ACTIVE with ICCID: status/usage/suspend enabled, resume disabled, top-up hidden, QR per stored data', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ qrCodeUrl: 'https://qr.example/lpa' }) })
    expect(a.isChoiceProvider).toBe(true)
    expect(a.refreshStatus).toMatchObject({ visible: true, enabled: true })
    expect(a.refreshUsage).toMatchObject({ visible: true, enabled: true })
    expect(a.suspend).toMatchObject({ visible: true, enabled: true })
    expect(a.resume).toMatchObject({ visible: true, enabled: false, reason: 'Resume is only available for suspended eSIMs.' })
    expect(a.topUp.visible).toBe(false)
    expect(a.qrCode).toMatchObject({ visible: true, enabled: true })
  })

  it('Choice ACTIVE with only IMSI still has a valid provider identifier', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ iccid: '', imsi: '310410123456789' }) })
    expect(a.refreshStatus.enabled).toBe(true)
    expect(a.refreshUsage.enabled).toBe(true)
    expect(a.suspend.enabled).toBe(true)
  })

  it('Choice ACTIVE with only imsi_version from providerResponse still has a valid provider identifier', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ iccid: '', imsi: null, providerResponse: { package: { imsi_version: 70 } } }) })
    expect(a.refreshStatus.enabled).toBe(true)
    expect(a.refreshUsage.enabled).toBe(true)
    expect(a.suspend.enabled).toBe(true)
  })

  it('Choice missing ICCID/IMSI/imsi_version disables status and usage with the identifier reason', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ iccid: '', imsi: null, providerResponse: {} }) })
    expect(a.refreshStatus).toMatchObject({ visible: true, enabled: false, reason: 'Provider identifier unavailable (no ICCID, IMSI, or imsi_version).' })
    expect(a.refreshUsage).toMatchObject({ visible: true, enabled: false, reason: 'Provider identifier unavailable (no ICCID, IMSI, or imsi_version).' })
    expect(a.suspend.enabled).toBe(false)
  })

  it('Choice never uses the local eSIM id as a provider identifier', () => {
    const a = getEsimActionAvailability({
      provider: choice,
      esim: choiceEsim({ iccid: '', imsi: null, providerResponse: {}, providerActivationId: 'esim-local-1' }),
    })
    expect(a.refreshStatus.enabled).toBe(false)
    expect(a.refreshUsage.enabled).toBe(false)
  })

  it('Choice SUSPENDED with ICCID: suspend disabled, resume enabled', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ status: 'SUSPENDED' }) })
    expect(a.suspend).toMatchObject({ visible: true, enabled: false, reason: 'Suspend is not available for SUSPENDED status.' })
    expect(a.resume).toMatchObject({ visible: true, enabled: true })
  })

  it('Choice EXPIRED with ICCID: suspend and resume disabled, top-up hidden', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ status: 'EXPIRED' }) })
    expect(a.suspend.enabled).toBe(false)
    expect(a.resume.enabled).toBe(false)
    expect(a.topUp.visible).toBe(false)
  })

  it('Choice PENDING_ACTIVATION and PENDING allow suspend', () => {
    for (const status of ['PENDING_ACTIVATION', 'PENDING']) {
      const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ status }) })
      expect(a.suspend.enabled).toBe(true)
    }
  })

  it('Choice FAILED, CANCELLED, and REFUNDED disable suspend', () => {
    for (const status of ['FAILED', 'CANCELLED', 'REFUNDED']) {
      const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ status }) })
      expect(a.suspend.enabled).toBe(false)
    }
  })

  it('Choice QR enabled via qrCodeUrl even without a retrieval flag', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ qrCodeUrl: 'https://qr.example/lpa' }) })
    expect(a.qrCode.enabled).toBe(true)
    expect(a.qrCode.reason).toBeUndefined()
  })

  it('Choice QR enabled via activationCode when qrCodeUrl is absent (modal can derive LPA QR)', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ qrCodeUrl: null, activationCode: '1$SM.DP+ANDROID:...' }) })
    expect(a.qrCode.enabled).toBe(true)
  })

  it('Choice with neither QR field disables QR with the data-specific note (no provider call)', () => {
    const a = getEsimActionAvailability({ provider: choice, esim: choiceEsim({ qrCodeUrl: null, activationCode: null }) })
    expect(a.qrCode.enabled).toBe(false)
    expect(a.qrCode.reason).toBe('Choice did not return QR activation data for this eSIM.')
  })
})

describe('getEsimActionAvailability — other providers', () => {
  it('AirHub (STATUS only) shows Refresh Status but hides Usage/Suspend/Resume/Top Up and disables QR without stored data', () => {
    const airhub = provider({ code: 'AIRHUB' })
    const a = getEsimActionAvailability({ provider: airhub, esim: esim({ qrCodeUrl: null, activationCode: null }) })
    expect(a.refreshStatus).toMatchObject({ visible: true, enabled: true })
    expect(a.refreshUsage.visible).toBe(false)
    expect(a.suspend.visible).toBe(false)
    expect(a.resume.visible).toBe(false)
    expect(a.topUp.visible).toBe(false)
    expect(a.qrCode).toMatchObject({ visible: true, enabled: false, reason: 'No QR activation data available for this eSIM.' })
  })

  it('AirHub with supportsQRCode and ICCID can retrieve the QR from the provider', () => {
    const airhub = provider({ code: 'AIRHUB', supportsQRCode: true })
    const a = getEsimActionAvailability({ provider: airhub, esim: esim({ qrCodeUrl: null, activationCode: null }) })
    expect(a.qrCode.enabled).toBe(true)
  })

  it('AirHub with stored activationCode keeps QR enabled even without the retrieval flag', () => {
    const airhub = provider({ code: 'AIRHUB' })
    const a = getEsimActionAvailability({ provider: airhub, esim: esim({ qrCodeUrl: null, activationCode: '1$SM.DP+...' }) })
    expect(a.qrCode.enabled).toBe(true)
  })

  it('iBASIS (STATUS only) with ICCID: refreshStatus enabled, suspend hidden, resume hidden, usage hidden', () => {
    const ibasis = provider({ code: 'IBASIS' })
    const a = getEsimActionAvailability({ provider: ibasis, esim: esim() })
    expect(a.refreshStatus.enabled).toBe(true)
    expect(a.suspend.visible).toBe(false)
    expect(a.resume.visible).toBe(false)
    expect(a.refreshUsage.visible).toBe(false)
    expect(a.topUp.visible).toBe(false)
  })

  it('generic custom provider with no declared capabilities renders no capability actions', () => {
    const generic = provider({ code: 'CUSTOM', capabilities: [] })
    const a = getEsimActionAvailability({ provider: generic, esim: esim() })
    expect(a.refreshStatus.visible).toBe(false)
    expect(a.refreshUsage.visible).toBe(false)
    expect(a.suspend.visible).toBe(false)
    expect(a.resume.visible).toBe(false)
    expect(a.topUp.visible).toBe(false)
    expect(a.qrCode.visible).toBe(true)
  })

  it('generic custom provider with explicit capabilities renders exactly those actions', () => {
    const custom = provider({ code: 'CUSTOM', capabilities: ['STATUS', 'SUSPEND', 'RESUME'] })
    const a = getEsimActionAvailability({ provider: custom, esim: esim() })
    expect(a.refreshStatus.visible).toBe(true)
    expect(a.suspend.visible).toBe(true)
    expect(a.resume.visible).toBe(true)
    expect(a.refreshUsage.visible).toBe(false)
    expect(a.topUp.visible).toBe(false)
  })

  it('uses providerActivationId as a valid reference identifier for non-Choice providers', () => {
    const airhub = provider({ code: 'AIRHUB' })
    const a = getEsimActionAvailability({ provider: airhub, esim: esim({ iccid: '', providerActivationId: 'act-123' }) })
    expect(a.refreshStatus.enabled).toBe(true)
  })

  it('disabled status/usage actions for non-Choice expose the generic identifier reason', () => {
    const airhub = provider({ code: 'AIRHUB' })
    const a = getEsimActionAvailability({ provider: airhub, esim: esim({ iccid: '' }) })
    expect(a.refreshStatus.reason).toBe('Provider identifier unavailable.')
  })
})

describe('getEsimActionAvailability — top up', () => {
  const telna = provider({ code: 'TELNA', supportsTopUp: true })

  it('Top Up enabled only when TOP_UP capability + supportsTopUp + non-terminal status + ICCID', () => {
    const a = getEsimActionAvailability({ provider: telna, esim: esim() })
    expect(a.topUp).toMatchObject({ visible: true, enabled: true })
  })

  it('Top Up hidden when TOP_UP is not declared even if supportsTopUp is true', () => {
    const choice = provider({ code: 'CHOICE', supportsTopUp: true })
    const a = getEsimActionAvailability({ provider: choice, esim: esim() })
    expect(a.topUp.visible).toBe(false)
  })

  it('Top Up disabled with provider-level reason when TOP_UP declared but supportsTopUp is false', () => {
    const telnaNoTopUp = provider({ code: 'TELNA', supportsTopUp: false })
    const a = getEsimActionAvailability({ provider: telnaNoTopUp, esim: esim() })
    expect(a.topUp).toMatchObject({ visible: true, enabled: false, reason: 'Top up is disabled for this provider.' })
  })

  it('Top Up disabled for terminal statuses (EXPIRED/FAILED/CANCELLED/REFUNDED)', () => {
    for (const status of ['EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']) {
      const a = getEsimActionAvailability({ provider: telna, esim: esim({ status }) })
      expect(a.topUp.enabled).toBe(false)
      expect(a.topUp.reason).toBe(`Top up is not available for ${status} status.`)
    }
  })

  it('Top Up disabled when the eSIM has no ICCID', () => {
    const a = getEsimActionAvailability({ provider: telna, esim: esim({ iccid: '' }) })
    expect(a.topUp.enabled).toBe(false)
    expect(a.topUp.reason).toBe('Provider identifier unavailable for top-up.')
  })
})

describe('getUsagePanelState', () => {
  const choice = provider({ code: 'CHOICE' })
  const airhub = provider({ code: 'AIRHUB' })

  it('USAGE provider without a snapshot shows the panel (capability mode → "Usage unavailable" in summary)', () => {
    expect(getUsagePanelState(choice, esim({ dataTotalMB: null, dataRemainingMB: null })).mode).toBe('capability')
  })

  it('non-USAGE provider without a snapshot hides the panel', () => {
    expect(getUsagePanelState(airhub, esim({ dataTotalMB: null, dataRemainingMB: null })).mode).toBe('hidden')
  })

  it('non-USAGE provider with a valid historic snapshot shows the panel labelled as last synced', () => {
    expect(getUsagePanelState(airhub, esim({ dataTotalMB: 1024 })).mode).toBe('historic')
  })

  it('valid zero-usage snapshot (real total) stays a valid snapshot', () => {
    expect(getUsagePanelState(choice, esim({ dataUsedMB: 0, dataTotalMB: 1024, dataRemainingMB: 1024 })).mode).toBe('capability')
  })
})

describe('getEsimStatusLabel', () => {
  it('never maps PENDING_ACTIVATION to ACTIVE', () => {
    expect(getEsimStatusLabel('PENDING_ACTIVATION').label).toBe('Ready to install')
    expect(getEsimStatusLabel('ACTIVE').label).toBe('Active')
    expect(getEsimStatusLabel('PENDING_ACTIVATION').label).not.toBe(getEsimStatusLabel('ACTIVE').label)
  })

  it('distinguishes ACTIVE from INSTALLED', () => {
    expect(getEsimStatusLabel('ACTIVE').label).toBe('Active')
    expect(getEsimStatusLabel('INSTALLED').label).toBe('Installed on device')
    expect(getEsimStatusLabel('ACTIVE').label).not.toBe(getEsimStatusLabel('INSTALLED').label)
  })

  it('keeps unknown provider statuses visible verbatim', () => {
    expect(getEsimStatusLabel('deactivated_weird').label).toBe('deactivated_weird')
    expect(getEsimStatusLabel(null).label).toBe('Unknown')
  })

  it('labels terminal lifecycle statuses distinctly', () => {
    expect(getEsimStatusLabel('EXPIRED').label).toBe('Expired')
    expect(getEsimStatusLabel('SUSPENDED').label).toBe('Suspended')
    expect(getEsimStatusLabel('FAILED').label).toBe('Failed')
  })
})
