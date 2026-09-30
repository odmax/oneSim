import { describe, it, expect } from 'vitest'
import {
  deriveEsimInventoryStatus,
  derivePollingState,
  hasDeviceInstallEvidence,
  hasHistoricalActivationEvidence,
  isProviderReportedInstallFailure,
} from './inventory-status'

const base = {
  status: 'PENDING_ACTIVATION',
  installationStatus: 'PENDING',
  installationLastError: null,
  installationLastCheckedAt: null,
  activationCode: null,
  qrCodeUrl: null,
  qrCode: null,
  smdpAddress: null,
  matchingId: null,
  activatedAt: null,
  activationDetectedAt: null,
  dataUsedMB: 0,
  dataTotalMB: null,
  dataRemainingMB: null,
  lastStatusSyncAt: null,
  statusSyncRetryCount: 0,
  statusNextSyncAt: null,
  lastUsageSyncAt: null,
}

describe('deriveEsimInventoryStatus — installation details', () => {
  it('READY means installation details are available; it does NOT prove installed or uninstalled', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'READY' })
    expect(inv.installation.detailsAvailable).toBe(true)
    expect(inv.installation.label).toBe('Installation details available')
    // READY is not device-install evidence → device state stays unknown (never NOT_INSTALLED).
    expect(inv.device.state).toBe('UNKNOWN')
    expect(inv.device.label).not.toBe('Not installed')
  })

  it('QR/activation code means installation details are available', () => {
    const withQR = deriveEsimInventoryStatus({ ...base, qrCode: 'LPA:1$smdp$matching' })
    expect(withQR.installation.detailsAvailable).toBe(true)
    const withCode = deriveEsimInventoryStatus({ ...base, activationCode: '1$smdp$matching' })
    expect(withCode.installation.detailsAvailable).toBe(true)
  })

  it('no READY and no QR/activation code ⇒ no installation details', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationLastError: 'lookup failed' })
    expect(inv.installation.detailsAvailable).toBe(false)
    expect(inv.installation.label).toBe('No installation details')
  })

  it('INSTALLED/ENABLED/DOWNLOADED/INSTALLING without QR/activation data do NOT mean install details are available', () => {
    for (const install of ['INSTALLED', 'ENABLED', 'DOWNLOADED', 'INSTALLING']) {
      const inv = deriveEsimInventoryStatus({ ...base, installationStatus: install })
      expect(inv.installation.detailsAvailable).toBe(false)
      expect(inv.installation.label).toBe('No installation details')
    }
  })

  it('device-install values without data stay separate: device label is still derived, details are not', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'INSTALLED' })
    expect(inv.device.state).toBe('INSTALLED')          // device axis unchanged
    expect(inv.installation.detailsAvailable).toBe(false) // install-instructions axis separate
  })

  it('READY alone (without stored QR/activation data) still means installation details are available', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'READY' })
    expect(inv.installation.detailsAvailable).toBe(true)
    expect(inv.installation.label).toBe('Installation details available')
  })

  it('valid QR/activation data marks details available even when the install status is INSTALLED', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'INSTALLED', qrCodeUrl: 'https://qr.example/q.png' })
    expect(inv.installation.detailsAvailable).toBe(true)
  })
})

describe('device installation — current-install evidence is separate from historical activation', () => {
  it('explicit INSTALLED installation evidence ⇒ Installed (latest evidence), never inferred', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'INSTALLED' })
    expect(inv.device.state).toBe('INSTALLED')
    expect(inv.device.label).toBe('Installed (latest evidence)')
    expect(inv.device.evidence.join(' ')).toContain('installationStatus=INSTALLED/ENABLED')
  })

  it('explicit ENABLED installation evidence ⇒ Installed (latest evidence)', () => {
    expect(deriveEsimInventoryStatus({ ...base, installationStatus: 'ENABLED' }).device.state).toBe('INSTALLED')
  })

  it('canonical ACTIVE alone does NOT label Installed — it is activated/used, install unconfirmed', () => {
    const inv = deriveEsimInventoryStatus({ ...base, status: 'ACTIVE', activatedAt: new Date('2026-01-01') })
    expect(inv.device.state).not.toBe('INSTALLED')
    expect(inv.device.state).toBe('ACTIVATED_UNCONFIRMED_INSTALL')
    expect(inv.device.label).toBe('Activated/used; current installation unconfirmed')
  })

  it('activation timestamp alone does NOT prove current installation', () => {
    const inv = deriveEsimInventoryStatus({ ...base, activatedAt: new Date('2026-01-01') })
    expect(inv.device.state).toBe('ACTIVATED_UNCONFIRMED_INSTALL')
  })

  it('recorded usage alone does NOT prove current installation', () => {
    const inv = deriveEsimInventoryStatus({ ...base, dataUsedMB: 512, dataTotalMB: 2048 })
    expect(inv.device.state).toBe('ACTIVATED_UNCONFIRMED_INSTALL')
  })

  it('explicit INSTALLED evidence takes precedence over historical activation', () => {
    const inv = deriveEsimInventoryStatus({
      ...base,
      status: 'ACTIVE',
      installationStatus: 'INSTALLED',
      activatedAt: new Date('2026-01-01'),
      dataUsedMB: 512,
    })
    expect(inv.device.state).toBe('INSTALLED')
  })

  it('explicit provider-reported FAILED evidence takes precedence over historical activation', () => {
    const inv = deriveEsimInventoryStatus({
      ...base,
      status: 'ACTIVE',
      installationStatus: 'FAILED',
      installationLastError: 'Provider reports profile installation error',
    })
    expect(inv.device.state).toBe('INSTALL_FAILED')
  })

  it('INSTALLING and DOWNLOADED stay explicit install lifecycle values', () => {
    expect(deriveEsimInventoryStatus({ ...base, installationStatus: 'INSTALLING' }).device.state).toBe('INSTALLING')
    expect(deriveEsimInventoryStatus({ ...base, installationStatus: 'DOWNLOADED' }).device.state).toBe('DOWNLOADED')
  })

  it('READY/QR install details never imply Installed and never imply Not installed', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'READY', qrCode: 'LPA:1$a$b' })
    expect(inv.device.state).not.toBe('INSTALLED')
    expect(inv.device.state).not.toBe('DOWNLOADED')
    expect(inv.device.state).toBe('UNKNOWN')
  })

  it('latest evidence carries a status-check time when known (installationLastCheckedAt or lastStatusSyncAt)', () => {
    const check = new Date('2026-01-05T10:00:00Z')
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'INSTALLED', installationLastCheckedAt: check })
    expect(inv.device.checkedAt).toBe(check.toISOString())
    const viaSync = deriveEsimInventoryStatus({ ...base, installationStatus: 'ENABLED', lastStatusSyncAt: check })
    expect(viaSync.device.checkedAt).toBe(check.toISOString())
    expect(deriveEsimInventoryStatus({ ...base, installationStatus: 'INSTALLED' }).device.checkedAt).toBeNull()
  })

  it('hasDeviceInstallEvidence is true only for explicit normalized install evidence', () => {
    expect(hasDeviceInstallEvidence({ ...base, installationStatus: 'INSTALLED' })).toBe(true)
    expect(hasDeviceInstallEvidence({ ...base, installationStatus: 'ENABLED' })).toBe(true)
    expect(hasDeviceInstallEvidence({ ...base, status: 'ACTIVE' })).toBe(false)
    expect(hasDeviceInstallEvidence({ ...base, activatedAt: new Date('2026-01-01') })).toBe(false)
    expect(hasDeviceInstallEvidence({ ...base, dataUsedMB: 128 })).toBe(false)
    expect(hasDeviceInstallEvidence({ ...base, installationStatus: 'READY', qrCode: 'LPA:1$a$b' })).toBe(false)
    expect(hasDeviceInstallEvidence({ ...base, installationStatus: 'FAILED' })).toBe(false)
  })

  it('hasHistoricalActivationEvidence is true for ACTIVE/timestamps/usage, false otherwise', () => {
    expect(hasHistoricalActivationEvidence({ ...base, status: 'ACTIVE' })).toBe(true)
    expect(hasHistoricalActivationEvidence({ ...base, activatedAt: new Date('2026-01-01') })).toBe(true)
    expect(hasHistoricalActivationEvidence({ ...base, activationDetectedAt: new Date('2026-01-01') })).toBe(true)
    expect(hasHistoricalActivationEvidence({ ...base, dataUsedMB: 10 })).toBe(true)
    expect(hasHistoricalActivationEvidence({ ...base, installationStatus: 'INSTALLED' })).toBe(false)
    expect(hasHistoricalActivationEvidence({ ...base })).toBe(false)
  })
})

describe('installation failure — EXACT match against the two provider messages the app persists', () => {
  it(`exact 'Provider reports profile installation error' matches`, () => {
    expect(isProviderReportedInstallFailure('Provider reports profile installation error')).toBe(true)
    expect(deriveEsimInventoryStatus({ ...base, installationStatus: 'FAILED', installationLastError: 'Provider reports profile installation error' }).device.state).toBe('INSTALL_FAILED')
  })

  it(`trimmed/case-normalized exact message still matches`, () => {
    expect(isProviderReportedInstallFailure('  PROVIDER REPORTS PROFILE INSTALLATION ERROR  ')).toBe(true)
  })

  it(`exact 'Telna reported an eSIM profile download or installation failure' matches`, () => {
    expect(isProviderReportedInstallFailure('Telna reported an eSIM profile download or installation failure')).toBe(true)
    expect(deriveEsimInventoryStatus({ ...base, installationStatus: 'FAILED', installationLastError: 'Telna reported an eSIM profile download or installation failure' }).device.state).toBe('INSTALL_FAILED')
  })

  it('messages with extra text do NOT match', () => {
    expect(isProviderReportedInstallFailure('Provider reports profile installation error - retrying')).toBe(false)
    expect(isProviderReportedInstallFailure('Warning: Telna reported an eSIM profile download or installation failure')).toBe(false)
    expect(isProviderReportedInstallFailure('Provider reports profile installation error (minor)')).toBe(false)
  })

  it('lookup/recovery failures and generic failure text do NOT match', () => {
    expect(isProviderReportedInstallFailure(null)).toBe(false)
    expect(isProviderReportedInstallFailure('')).toBe(false)
    expect(isProviderReportedInstallFailure('Installation-data lookup failed')).toBe(false)
    expect(isProviderReportedInstallFailure('no activation code returned')).toBe(false)
    expect(isProviderReportedInstallFailure('Status reflection failed')).toBe(false)
    expect(isProviderReportedInstallFailure('failed')).toBe(false)
  })

  it('FAILED without a provider report is NOT a device failure', () => {
    const inv = deriveEsimInventoryStatus({ ...base, installationStatus: 'FAILED', installationLastError: 'Installation-data lookup failed' })
    expect(inv.device.state).not.toBe('INSTALL_FAILED')
    expect(inv.device.state).toBe('UNKNOWN')
    expect(inv.device.label).toBe('Installation details unavailable')
  })
})

describe('usage — used / total / remaining / last check, or "Usage unavailable"', () => {
  it('no authoritative snapshot ⇒ "Usage unavailable" and no fabricated numbers', () => {
    const inv = deriveEsimInventoryStatus({ ...base })
    expect(inv.usage.hasSnapshot).toBe(false)
    expect(inv.usage.label).toBe('Usage unavailable')
    expect(inv.usage.usedLabel).toBeNull()
    expect(inv.usage.totalLabel).toBeNull()
    expect(inv.usage.remainingLabel).toBeNull()
    expect(inv.usage.lastUsageCheckAt).toBeNull()
  })

  it('known snapshot renders used / total / remaining and the last usage check', () => {
    const lastUsage = new Date('2026-01-03T09:00:00Z')
    const inv = deriveEsimInventoryStatus({ ...base, dataUsedMB: 256, dataTotalMB: 1024, dataRemainingMB: 768, lastUsageSyncAt: lastUsage })
    expect(inv.usage.hasSnapshot).toBe(true)
    expect(inv.usage.usedLabel).toBe('0.25 GB')
    expect(inv.usage.totalLabel).toBe('1.00 GB')
    expect(inv.usage.remainingLabel).toBe('0.75 GB')
    expect(inv.usage.lastUsageCheckAt).toBe(lastUsage.toISOString())
    expect(inv.usage.label).toContain('0.25 GB')
    expect(inv.usage.label).toContain('1.00 GB')
    expect(inv.usage.label).toContain('0.75 GB')
  })

  it('real snapshot with known zero used renders "0.00 GB" (a genuine zero, not missing)', () => {
    const inv = deriveEsimInventoryStatus({ ...base, dataUsedMB: 0, dataTotalMB: 1024 })
    expect(inv.usage.hasSnapshot).toBe(true)
    expect(inv.usage.usedLabel).toBe('0.00 GB')
  })

  it('last usage check is null when no sync timestamp exists', () => {
    const inv = deriveEsimInventoryStatus({ ...base, dataUsedMB: 100, dataTotalMB: 1024 })
    expect(inv.usage.lastUsageCheckAt).toBeNull()
  })
})

describe('derivePollingState — scheduler bookkeeping (statusNextSyncAt / retry shape)', () => {
  const now = new Date('2026-01-10T12:00:00Z')

  it('never checked and no retries ⇒ UNSYNCED / "Not yet checked"', () => {
    const p = derivePollingState({ lastStatusSyncAt: null, statusSyncRetryCount: 0, statusNextSyncAt: null }, now)
    expect(p.state).toBe('UNSYNCED')
    expect(p.label).toBe('Not yet checked')
    expect(p.neverChecked).toBe(true)
    expect(p.lastCheckAt).toBeNull()
  })

  it('REAL scheduler failure shape (lastStatusSyncAt set AND retries > 0) ⇒ FAILED "Status check failing"', () => {
    const at = new Date('2026-01-10T11:55:00Z')
    const p = derivePollingState({ lastStatusSyncAt: at, statusSyncRetryCount: 3, statusNextSyncAt: new Date('2026-01-10T12:05:00Z') }, now)
    expect(p.state).toBe('FAILED')
    expect(p.label).toBe('Status check failing')
    expect(p.failing).toBe(true)
    expect(p.lastCheckAt).toBe(at.toISOString())
    expect(p.nextSyncAt).toBe('2026-01-10T12:05:00.000Z')
  })

  it('budget-exhausted failure (retries > 0, statusNextSyncAt null) ⇒ "Status check stopped"', () => {
    const at = new Date('2026-01-10T11:55:00Z')
    const p = derivePollingState({ lastStatusSyncAt: at, statusSyncRetryCount: 5, statusNextSyncAt: null }, now)
    expect(p.state).toBe('FAILED')
    expect(p.label).toBe('Status check stopped')
    expect(p.stopped).toBe(true)
    expect(p.failing).toBe(true)
    expect(p.lastCheckAt).toBe(at.toISOString())
  })

  it('healthy check on cadence (next in future, retries 0) ⇒ "Status synced"', () => {
    const at = new Date('2026-01-10T06:00:00Z')
    const p = derivePollingState({ lastStatusSyncAt: at, statusSyncRetryCount: 0, statusNextSyncAt: new Date('2026-01-10T18:00:00Z') }, now)
    expect(p.state).toBe('SYNCED')
    expect(p.label).toBe('Status synced')
    expect(p.due).toBe(false)
    expect(p.failing).toBe(false)
    expect(p.lastCheckAt).toBe(at.toISOString())
  })

  it('check due/overdue (next <= now, retries 0) ⇒ "Status check due"', () => {
    const at = new Date('2026-01-10T11:00:00Z')
    const p = derivePollingState({ lastStatusSyncAt: at, statusSyncRetryCount: 0, statusNextSyncAt: new Date('2026-01-10T11:30:00Z') }, now)
    expect(p.state).toBe('SYNCED')
    expect(p.label).toBe('Status check due')
    expect(p.due).toBe(true)
  })

  it('synced once then scheduler stopped (next null, retries 0) ⇒ "Status synced — polling stopped"', () => {
    const at = new Date('2026-01-09T06:00:00Z')
    const p = derivePollingState({ lastStatusSyncAt: at, statusSyncRetryCount: 0, statusNextSyncAt: null }, now)
    expect(p.state).toBe('SYNCED')
    expect(p.label).toBe('Status synced — polling stopped')
    expect(p.stopped).toBe(true)
  })

  it('polling state never depends on any usage-staleness threshold (no "Status check stale" label)', () => {
    const oldAt = new Date('2026-01-01T06:00:00Z')
    const p = derivePollingState({ lastStatusSyncAt: oldAt, statusSyncRetryCount: 0, statusNextSyncAt: new Date('2026-01-20T00:00:00Z') }, now)
    expect(p.label).not.toBe('Status check stale')
    expect(p.label).toBe('Status synced')
  })
})

describe('deriveEsimInventoryStatus — provider neutrality', () => {
  it('does not read providerStatus and never returns provider vocabulary', () => {
    const inv = deriveEsimInventoryStatus({ ...base, providerStatus: 'ACTIVE' } as any)
    expect(inv.providerNeutral).toBe(true)
    const raw = JSON.stringify(inv)
    // canonical service stays provisioning despite the raw ACTIVE claim
    expect(inv.service.status).toBe('PENDING_ACTIVATION')
    // no provider raw value appears in any customer-facing label
    expect(raw).not.toContain('ACTIVE')
  })

  it('service lifecycle stays on its own axis (ACTIVE service with no install evidence)', () => {
    const inv = deriveEsimInventoryStatus({ ...base, status: 'ACTIVE' })
    expect(inv.service.status).toBe('ACTIVE')
    expect(inv.service.label).toBe('Active')
    expect(inv.device.state).toBe('ACTIVATED_UNCONFIRMED_INSTALL')
  })
})
