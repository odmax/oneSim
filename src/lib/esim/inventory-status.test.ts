import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
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

describe('primary status precedence — one customer-safe badge', () => {
  const list = (row: Record<string, unknown>) => deriveEsimInventoryStatus({ ...base, ...row } as any).primary

  it('canonical DEPLETED wins over usage, install evidence, and READY state', () => {
    const p = list({ status: 'DEPLETED', installationStatus: 'INSTALLED', dataTotalMB: 1024, dataRemainingMB: 200 })
    expect(p.status).toBe('DEPLETED')
    expect(p.label).toBe('Depleted')
    expect(p.tone).toBe('danger')
  })

  it('authoritative fresh usage snapshot with no data remaining produces DEPLETED', () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000)
    const p = list({ status: 'ACTIVE', dataTotalMB: 1024, dataRemainingMB: 0, lastUsageSyncAt: fresh })
    expect(p.status).toBe('DEPLETED')
    expect(p.label).toBe('Depleted')
  })

  it('exactly-zero remaining data is DEPLETED (a genuine zero, not missing)', () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000)
    const p = list({ status: 'ACTIVE', dataTotalMB: 1024, dataRemainingMB: 0, lastUsageSyncAt: fresh })
    expect(p.status).toBe('DEPLETED')
  })

  it('ACTIVE below/at the shared 10% low-data threshold is LOW', () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000)
    // exactly at the threshold: 100 / 1000 === 0.10
    const at = list({ status: 'ACTIVE', dataTotalMB: 1000, dataRemainingMB: 100, lastUsageSyncAt: fresh })
    expect(at.status).toBe('LOW')
    expect(at.label).toBe('Low')
    expect(at.tone).toBe('warn')
    // just below: 90 / 1000 === 0.09
    const below = list({ status: 'ACTIVE', dataTotalMB: 1000, dataRemainingMB: 90, lastUsageSyncAt: fresh })
    expect(below.status).toBe('LOW')
  })

  it('ACTIVE above the shared threshold stays ACTIVE', () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000)
    const p = list({ status: 'ACTIVE', dataTotalMB: 1000, dataRemainingMB: 101, lastUsageSyncAt: fresh })
    expect(p.status).toBe('ACTIVE')
    expect(p.label).toBe('Active')
    expect(p.tone).toBe('success')
  })

  it('missing usage is never turned into zero or a LOW/DEPLETED badge', () => {
    const p = list({ status: 'ACTIVE', dataTotalMB: null, dataRemainingMB: null, lastUsageSyncAt: null })
    expect(p.status).toBe('ACTIVE')
    expect(p.label).toBe('Active')
    expect(deriveEsimInventoryStatus({ ...base, status: 'ACTIVE' } as any).usage.label).toBe('Usage unavailable')
  })

  it('a stale usage snapshot does not demote ACTIVE to DEPLETED (status stays honest, tooltip carries staleness)', () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000) // > 12h threshold
    const inv = deriveEsimInventoryStatus({ ...base, status: 'ACTIVE', dataTotalMB: 1024, dataRemainingMB: 0, lastUsageSyncAt: stale } as any)
    expect(inv.primary.status).toBe('ACTIVE')
    expect(inv.usage.stale).toBe(true)
  })

  it('terminal lifecycle states are preserved verbatim and never disguised as a primary status', () => {
    expect(list({ status: 'EXPIRED' })).toMatchObject({ status: 'EXPIRED', label: 'Expired' })
    expect(list({ status: 'FAILED' })).toMatchObject({ status: 'FAILED', label: 'Failed' })
    expect(list({ status: 'SUSPENDED' })).toMatchObject({ status: 'SUSPENDED', label: 'Suspended' })
    expect(list({ status: 'CANCELLED' })).toMatchObject({ status: 'CANCELLED', label: 'Cancelled' })
    expect(list({ status: 'REFUNDED' })).toMatchObject({ status: 'REFUNDED', label: 'Refunded' })
    // terminal status wins over a low/data-depleted usage snapshot and install evidence
    expect(list({ status: 'EXPIRED', dataTotalMB: 1000, dataRemainingMB: 50, installationStatus: 'INSTALLED' }).status).toBe('EXPIRED')
  })

  it('canonical INSTALLED service renders "Installed on device"', () => {
    const p = list({ status: 'INSTALLED' })
    expect(p.status).toBe('INSTALLED')
    expect(p.label).toBe('Installed on device')
  })

  it('explicit normalized install evidence (installationStatus=INSTALLED) wins over READY/QR', () => {
    const p = list({ status: 'PENDING_ACTIVATION', installationStatus: 'INSTALLED', qrCode: 'LPA:1$a$b' })
    expect(p.status).toBe('INSTALLED')
    expect(p.label).toBe('Installed on device')
  })

  it('usable install details with unknown device state → Ready to install (available-to-install), never Installed', () => {
    const inv = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'READY', qrCode: 'LPA:1$a$b' } as any)
    expect(inv.device.state).toBe('UNKNOWN')
    expect(inv.primary.status).toBe('READY_TO_INSTALL')
    expect(inv.primary.label).toBe('Ready to install')
    expect(inv.primary.status).not.toBe('INSTALLED')
    // The label is available-to-install only — it never asserts not-installed.
    expect(inv.primary.evidence.join(' ')).toContain('install state not asserted')
  })

  it('Telna DOWNLOADED (provider-reported download checkpoint) renders the distinct Profile downloaded label, never Ready to install', () => {
    const p = list({ status: 'PENDING_ACTIVATION', installationStatus: 'DOWNLOADED' })
    expect(p.status).toBe('PROFILE_DOWNLOADED')
    expect(p.label).toBe('Profile downloaded')
    expect(p.status).not.toBe('READY_TO_INSTALL')
    expect(p.status).not.toBe('INSTALLED')
    // No in-repo authoritative source certifies "downloaded but not installed",
    // so the evidence string states exactly what is known.
    expect(p.evidence.join(' ')).toContain('download checkpoint')
    expect(p.evidence.join(' ')).not.toContain('not yet installed')
  })

  it('DOWNLOADED + usable QR/activation details still renders Profile downloaded (download beats install-details, never Ready to install)', () => {
    // Precedence regression: PROFILE_DOWNLOADED is evaluated BEFORE
    // READY_TO_INSTALL, so a DOWNLOADED installationStatus must stay
    // "Profile downloaded" even though usable install details are present.
    for (const row of [
      { status: 'PENDING_ACTIVATION', installationStatus: 'DOWNLOADED', qrCode: 'LPA:1$a$b' },
      { status: 'PENDING_ACTIVATION', installationStatus: 'DOWNLOADED', activationCode: '1$smdp$mid', qrCodeUrl: 'https://qr.example/q.png' },
    ]) {
      const inv = deriveEsimInventoryStatus({ ...base, ...row } as any)
      expect(inv.installation.detailsAvailable).toBe(true)
      expect(inv.device.state).toBe('DOWNLOADED')
      expect(inv.primary.status).toBe('PROFILE_DOWNLOADED')
      expect(inv.primary.label).toBe('Profile downloaded')
      expect(inv.primary.status).not.toBe('READY_TO_INSTALL')
      expect(inv.primary.status).not.toBe('INSTALLED')
    }
  })

  it('READY means install details are available, never that the profile is uninstalled', () => {
    const inv = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'READY', activationCode: '1$smdp$mid', dataUsedMB: 0 } as any)
    expect(inv.primary.status).toBe('READY_TO_INSTALL')
    expect(inv.primary.label).toBe('Ready to install')
    // The evidence is "available to install" — it never asserts not-installed.
    expect(inv.primary.evidence.join(' ')).toContain('install state not asserted')
    expect(inv.primary.evidence.join(' ')).not.toContain('not installed')
  })

  it('Ready to install is produced ONLY from usable install details with an unknown device state', () => {
    // usable details + provisioning + unknown device → Ready to install
    const ready = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'READY', activationCode: '1$smdp$mid', dataUsedMB: 0 } as any).primary
    expect(ready.status).toBe('READY_TO_INSTALL')
    expect(ready.label).toBe('Ready to install')
    // no usable details → Preparing, never Ready to install
    const pending = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'PENDING' } as any).primary
    expect(pending.status).toBe('PREPARING')
    expect(pending.status).not.toBe('READY_TO_INSTALL')
    // DOWNLOADED is a distinct evidence checkpoint, not Ready to install
    const downloaded = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'DOWNLOADED' } as any).primary
    expect(downloaded.status).toBe('PROFILE_DOWNLOADED')
    expect(downloaded.status).not.toBe('READY_TO_INSTALL')
  })

  it('raw provider ACTIVE never promotes a provisioning eSIM to Active', () => {
    const p = deriveEsimInventoryStatus({ ...base, providerStatus: 'ACTIVE' } as any).primary
    expect(p.status).not.toBe('ACTIVE')
  })

  it('unsupported provider capability yields an honest fallback, never a false Installed claim', () => {
    // No install capability, no install data, no usage → Preparing (honest neutral).
    const provisioning = list({ status: 'PENDING_ACTIVATION', installationStatus: 'PENDING' })
    expect(provisioning.status).toBe('PREPARING')
    expect(provisioning.label).toBe('Preparing')
    expect(provisioning.status).not.toBe('INSTALLED')
    // Install details exist but device installation is unknown → Ready to install
    // (available-to-install), never Installed.
    const withDetails = list({ status: 'PENDING_ACTIVATION', installationStatus: 'READY', qrCode: 'LPA:1$a$b' })
    expect(withDetails.status).toBe('READY_TO_INSTALL')
    expect(withDetails.label).toBe('Ready to install')
    expect(withDetails.status).not.toBe('INSTALLED')
    // A genuinely unknown canonical value → Status unavailable (raw retained on admin).
    const unknown = list({ status: 'WHATEVER' })
    expect(unknown.status).toBe('STATUS_UNAVAILABLE')
    expect(unknown.label).toBe('Status unavailable')
  })

  it('INSTALL_FAILED (provider-reported) is preserved as an exceptional device state before Ready to install', () => {
    const p = list({ status: 'PENDING_ACTIVATION', installationStatus: 'FAILED', installationLastError: 'Provider reports profile installation error' })
    expect(p.status).toBe('INSTALL_FAILED')
    expect(p.label).toBe('Installation failed')
  })

  it('customer confirmation alone produces Installed on device — customer confirmed, with a distinguishable evidence source', () => {
    const p = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'PENDING', customerReportedInstalled: true } as any).primary
    expect(p.status).toBe('INSTALLED')
    expect(p.label).toBe('Installed on device — customer confirmed')
    expect(p.evidence.join(' ')).toContain('customer-confirmed installation')
    // The device axis preserves the same source so details/audit stay truthful.
    const inv = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', customerReportedInstalled: true } as any)
    expect(inv.device.state).toBe('INSTALLED')
    expect(inv.device.label).toBe('Installed (customer confirmed)')
  })

  it('provider-confirmed install evidence beats a separate customer confirmation (source stays provider)', () => {
    const p = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'INSTALLED', customerReportedInstalled: true } as any).primary
    expect(p.status).toBe('INSTALLED')
    expect(p.evidence.join(' ')).toContain('explicit normalized installation evidence')
    expect(p.evidence.join(' ')).not.toContain('customer-confirmed')
    const inv = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'INSTALLED', customerReportedInstalled: true } as any)
    expect(inv.device.label).toBe('Installed (latest evidence)')
  })

  it('historical activation/usage with an unconfirmed install stays the neutral Provisioned (never Ready to install)', () => {
    const p = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'READY', dataUsedMB: 512, dataTotalMB: 2048 } as any).primary
    // Usage proves activation, not current install → NOT Ready to install.
    expect(p.status).toBe('PROVISIONED')
    expect(p.label).toBe('Provisioned')
    expect(p.status).not.toBe('READY_TO_INSTALL')
    expect(p.status).not.toBe('ACTIVE')
  })
})

describe('customer-confirmed installation — durable wiring + resolver contract', () => {
  it('is reload-safe: repeated derivation from the same row is identical and never mutates the input', () => {
    const row = { ...base, status: 'PENDING_ACTIVATION', customerReportedInstalled: true }
    const a = deriveEsimInventoryStatus(row as any)
    const b = deriveEsimInventoryStatus(row as any)
    expect(a.primary).toEqual(b.primary)
    expect(a.primary.status).toBe('INSTALLED')
    expect(a.primary.label).toBe('Installed on device — customer confirmed')
    // The resolver never clears or rewrites the provider-side columns or the flag.
    expect(row.customerReportedInstalled).toBe(true)
    expect(row.installationStatus).toBe('PENDING')
  })

  it('customer confirmation is never coerced into provider-confirmed evidence', () => {
    // customer-only → the evidence string names the customer source, never the provider.
    const customerOnly = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', customerReportedInstalled: true } as any).primary
    expect(customerOnly.evidence.join(' ')).toContain('customer-confirmed installation')
    expect(customerOnly.evidence.join(' ')).toContain('separately recorded')
    expect(customerOnly.evidence.join(' ')).not.toContain('explicit normalized installation evidence')
    // provider + customer → provider evidence wins and stays provider-confirmed.
    const both = deriveEsimInventoryStatus({ ...base, status: 'PENDING_ACTIVATION', installationStatus: 'INSTALLED', customerReportedInstalled: true } as any).primary
    expect(both.evidence.join(' ')).toContain('explicit normalized installation evidence')
    expect(both.evidence.join(' ')).not.toContain('customer-confirmed')
  })

  it('survives reload: the inventory row-mappers feed the persisted column into the shared resolver on BOTH pages', () => {
    // After the migration, the pages map customerConfirmedInstalledAt != null into
    // the resolver input, so the customer label is reachable from persisted data.
    for (const pagePath of ['src/app/admin/esims/page.tsx', 'src/app/business/esims/page.tsx']) {
      const content = readFileSync(path.join(process.cwd(), pagePath), 'utf8')
      expect(content).toContain('customerReportedInstalled: esim.customerConfirmedInstalledAt != null')
    }
  })

  it('status/usage syncs and the provider webhook processor never write or clear the confirmation column', () => {
    // These services use explicit updateData objects and never reference the
    // customer confirmation field, so it survives status/usage sync and webhooks.
    const sources = [
      'src/lib/services/esims/sync-esim-status.ts',
      'src/lib/services/usage/sync-usage.ts',
      'src/lib/services/webhooks/provider-webhook-processor.ts',
    ]
    for (const file of sources) {
      const content = readFileSync(path.join(process.cwd(), file), 'utf8')
      expect(content).not.toContain('customerConfirmedInstalledAt')
    }
  })
})

describe('provider fixtures — the same normalized evidence always renders the same primary label', () => {
  const fresh = new Date(Date.now() - 60 * 60 * 1000)

  const providerFixtures = ['choice', 'telna', 'telna_seamless', 'telna_flex', 'airhub', 'ibasis', 'usmatrix', 'mock']

  function labelFor(providerId: string, row: Record<string, unknown>): { status: string; label: string } {
    const p = deriveEsimInventoryStatus({ ...base, hasProviderId: providerId, ...row } as any).primary
    return { status: p.status, label: p.label }
  }

  it('active-with-ample-data renders exactly the same badge for every provider', () => {
    const expected = { status: 'ACTIVE', label: 'Active' }
    for (const id of providerFixtures) {
      expect(labelFor(id, { status: 'ACTIVE', dataTotalMB: 1024, dataRemainingMB: 512, lastUsageSyncAt: fresh })).toEqual(expected)
    }
  })

  it('ready-to-install-with-usable-details renders exactly the same badge for every provider', () => {
    const expected = { status: 'READY_TO_INSTALL', label: 'Ready to install' }
    for (const id of providerFixtures) {
      expect(labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'READY', activationCode: '1$smdp$mid', dataUsedMB: 0 })).toEqual(expected)
    }
  })

  it('provider-reported DOWNLOADED renders exactly the same Profile downloaded badge for every provider that reports it', () => {
    const expected = { status: 'PROFILE_DOWNLOADED', label: 'Profile downloaded' }
    for (const id of providerFixtures) {
      expect(labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'DOWNLOADED' })).toEqual(expected)
    }
  })

  it('explicit device-install evidence renders exactly the same Installed badge for every provider', () => {
    const expected = { status: 'INSTALLED', label: 'Installed on device' }
    for (const id of providerFixtures) {
      expect(labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'INSTALLED' })).toEqual(expected)
    }
  })

  it('separately recorded customer confirmation renders exactly the same customer-confirmed badge for every provider', () => {
    const expected = { status: 'INSTALLED', label: 'Installed on device — customer confirmed' }
    for (const id of providerFixtures) {
      expect(labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'PENDING', customerReportedInstalled: true })).toEqual(expected)
    }
  })

  it('no-capability fallback renders exactly the same Preparing badge for every provider', () => {
    const expected = { status: 'PREPARING', label: 'Preparing' }
    for (const id of providerFixtures) {
      expect(labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'PENDING' })).toEqual(expected)
    }
  })
})

describe('providers without a device-installation capability — unknown device state is never claimed as installed or uninstalled', () => {
  const fresh = new Date(Date.now() - 60 * 60 * 1000)

  // These providers report status/usage/QR but have NO per-eSIM device-install
  // evidence (no installationStatus INSTALLED/ENABLED/DOWNLOADED, no
  // networkAttached/deviceInstalled signals).
  const noDeviceCapabilityProviders = ['choice', 'airhub', 'ibasis', 'telna_flex', 'telna_seamless']

  function labelFor(providerId: string, row: Record<string, unknown>): { status: string; label: string } {
    const p = deriveEsimInventoryStatus({ ...base, hasProviderId: providerId, ...row } as any).primary
    return { status: p.status, label: p.label }
  }

  it('PENDING_ACTIVATION + valid QR details + unknown device state shows Ready to install (available-to-install) for every provider', () => {
    for (const id of noDeviceCapabilityProviders) {
      const p = labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'READY', qrCodeUrl: 'https://qr.example/q.png', activationCode: '1$smdp$matching', dataUsedMB: 0 })
      expect(p.status).toBe('READY_TO_INSTALL')
      expect(p.label).toBe('Ready to install')
      expect(p.label).not.toBe('Installed on device')
    }
  })

  it('QR + provisioning without any device-install capability never claims Installed on device without evidence', () => {
    for (const id of noDeviceCapabilityProviders) {
      // install data available, device state unknown → Ready to install (not Installed)
      expect(labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'READY', activationCode: '1$smdp$mid', dataUsedMB: 0 }).label).toBe('Ready to install')
      // no install data at all → Preparing
      const preparing = labelFor(id, { status: 'PENDING_ACTIVATION', installationStatus: 'PENDING' })
      expect(preparing.label).toBe('Preparing')
      expect(preparing.label).not.toBe('Installed on device')
      // canonical Active stays Active via lifecycle/usage (never Installed from QR)
      expect(labelFor(id, { status: 'ACTIVE', dataTotalMB: 1024, dataRemainingMB: 512, lastUsageSyncAt: fresh }).label).toBe('Active')
    }
  })

  it('usage-based Depleted/Low still follow the shared precedence for capability-less usage providers', () => {
    for (const id of noDeviceCapabilityProviders) {
      const depleted = labelFor(id, { status: 'ACTIVE', dataTotalMB: 1024, dataRemainingMB: 0, lastUsageSyncAt: fresh })
      expect(depleted.status).toBe('DEPLETED')
      const low = labelFor(id, { status: 'ACTIVE', dataTotalMB: 1000, dataRemainingMB: 90, lastUsageSyncAt: fresh })
      expect(low.status).toBe('LOW')
      const missing = labelFor(id, { status: 'ACTIVE', dataTotalMB: null, dataRemainingMB: null })
      expect(missing.label).not.toBe('Low')
      expect(missing.label).not.toBe('Depleted')
    }
  })
})