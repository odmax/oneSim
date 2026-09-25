import { describe, it, expect } from 'vitest'
import {
  deriveEsimLifecyclePresentation,
  deriveEsimLifecyclePresentationFromRow,
  deriveEsimCustomerDisplayStatus,
  deriveEsimCustomerDisplayStatusFromRow,
} from './lifecycle-presentation'

describe('service axis — canonical service labels (provider-neutral)', () => {
  it('PENDING_ACTIVATION makes its service label Provisioned (never the whole "Ready to install")', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: 'PENDING', hasUsableInstallData: false })
    expect(p.serviceStatus).toBe('PENDING_ACTIVATION')
    expect(p.serviceLabel).toBe('Provisioned')
    expect(p.serviceTone).toBe('warn')
  })

  it('maps every canonical service status to a customer-safe label', () => {
    const cases: Array<[string, string]> = [
      ['PENDING', 'Provisioning'],
      ['ACTIVE', 'Active'],
      ['DEPLETED', 'Depleted'],
      ['SUSPENDED', 'Suspended'],
      ['EXPIRED', 'Expired'],
      ['FAILED', 'Failed'],
      ['CANCELLED', 'Cancelled'],
      ['REFUNDED', 'Refunded'],
      ['INSTALLED', 'Installed on device'],
    ]
    for (const [status, label] of cases) {
      const p = deriveEsimLifecyclePresentation({ status })
      expect(p.serviceStatus).toBe(status)
      expect(p.serviceLabel).toBe(label)
    }
  })

  it('falls back to the raw value for unknown statuses', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'SOMETHING_NEW' })
    expect(p.serviceLabel).toBe('SOMETHING_NEW')
  })
})

describe('setup axis — Ready to install only with usable installation data', () => {
  it('PENDING_ACTIVATION + READY + usable install data → Setup: Ready to install', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: 'READY', hasUsableInstallData: true })
    expect(p.setupStatus).toBe('READY_TO_INSTALL')
    expect(p.setupLabel).toBe('Ready to install')
    expect(p.serviceLabel).toBe('Provisioned')
  })

  it('missing installation data never shows Ready to install (READY without data → Preparing)', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: 'READY', hasUsableInstallData: false })
    expect(p.setupLabel).not.toBe('Ready to install')
    expect(p.setupLabel).toBe('Preparing')
  })

  it('PENDING installation state → Preparing', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: 'PENDING', hasUsableInstallData: false })
    expect(p.setupLabel).toBe('Preparing')
  })

  it('missing installation evidence → Unknown', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION' })
    expect(p.setupStatus).toBe('UNKNOWN')
    expect(p.setupLabel).toBe('Unknown')
  })

  it('failure/stale/not-recoverable installation states never show Ready to install', () => {
    for (const state of ['FAILED', 'STALE', 'NOT_SUPPORTED', 'NOT_RECOVERABLE', 'PERMANENT_FAILURE']) {
      const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: state, hasUsableInstallData: true })
      expect(p.setupLabel).not.toBe('Ready to install')
    }
    expect(deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: 'FAILED' }).setupLabel).toBe('Installation failed')
    expect(deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: 'STALE' }).setupLabel).toBe('Installation unavailable')
  })
})

describe('setup axis — authoritative activation evidence implies Installed', () => {
  it('activatedAt present → Installed', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', activatedAt: new Date('2026-01-01') })
    expect(p.setupStatus).toBe('INSTALLED')
    expect(p.setupLabel).toBe('Installed')
  })

  it('activationDetectedAt present → Installed', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', activationDetectedAt: '2026-01-01T00:00:00Z' })
    expect(p.setupStatus).toBe('INSTALLED')
  })

  it('real usage > 0 → Installed (usage is activation evidence)', () => {
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', dataUsedMB: 512 })
    expect(p.setupStatus).toBe('INSTALLED')
  })

  it('zero used / missing usage never implies Installed', () => {
    expect(deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', dataUsedMB: 0, installationStatus: 'PENDING' }).setupLabel).toBe('Preparing')
    expect(deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', dataUsedMB: null, installationStatus: 'PENDING' }).setupLabel).toBe('Preparing')
  })

  it('canonical ACTIVE / DEPLETED implies Installed', () => {
    expect(deriveEsimLifecyclePresentation({ status: 'ACTIVE' }).setupStatus).toBe('INSTALLED')
    expect(deriveEsimLifecyclePresentation({ status: 'DEPLETED' }).setupStatus).toBe('INSTALLED')
  })

  it('raw provider ACTIVE is never an input (the helper has no provider-status field)', () => {
    // The input interface intentionally has no providerStatus member; a raw
    // provider ACTIVE claim alone cannot make the setup axis say Installed.
    const p = deriveEsimLifecyclePresentation({ status: 'PENDING_ACTIVATION', installationStatus: 'PENDING' })
    expect(p.setupStatus).not.toBe('INSTALLED')
  })
})

describe('deriveEsimLifecyclePresentationFromRow — safe persisted fields only', () => {
  it('builds service + setup from a persisted row', () => {
    const p = deriveEsimLifecyclePresentationFromRow({
      status: 'PENDING_ACTIVATION',
      installationStatus: 'READY',
      hasUsableInstallData: true,
      activatedAt: null,
      dataUsedMB: 0,
    })
    expect(p.serviceLabel).toBe('Provisioned')
    expect(p.setupLabel).toBe('Ready to install')
  })

  it('does not accept or expose raw provider status', () => {
    const row = { status: 'PENDING_ACTIVATION', installationStatus: 'PENDING', providerStatus: 'ACTIVE', dataUsedMB: 0 }
    const p = deriveEsimLifecyclePresentationFromRow({ status: row.status, installationStatus: row.installationStatus, hasUsableInstallData: false, dataUsedMB: row.dataUsedMB })
    expect(JSON.stringify(p)).not.toContain('ACTIVE')
    expect(p.serviceLabel).toBe('Provisioned')
  })
})

describe('deriveEsimCustomerDisplayStatus — single customer summary badge', () => {
  const readyRow = { status: 'PENDING_ACTIVATION', installationStatus: 'READY', hasUsableInstallData: true, dataUsedMB: 0 }
  const preparingRow = { status: 'PENDING_ACTIVATION', installationStatus: 'PENDING', hasUsableInstallData: false, dataUsedMB: 0 }
  const unknownRow = { status: 'PENDING_ACTIVATION', dataUsedMB: 0 }

  it('Provisioned + Ready to install → one "Ready to install" badge', () => {
    const d = deriveEsimCustomerDisplayStatus(readyRow)
    expect(d.label).toBe('Ready to install')
    expect(d.tone).toBe('warn')
    expect(d.status).toBe('PENDING_ACTIVATION')
  })

  it('Provisioned + Preparing → Preparing', () => {
    expect(deriveEsimCustomerDisplayStatus(preparingRow).label).toBe('Preparing')
  })

  it('Provisioned + Unknown/null → Provisioned', () => {
    const d = deriveEsimCustomerDisplayStatus(unknownRow)
    expect(d.label).toBe('Provisioned')
    expect(d.tone).toBe('warn')
  })

  it('Provisioned + Installation failed → Installation failed (dominant over Provisioned)', () => {
    const d = deriveEsimCustomerDisplayStatus({ status: 'PENDING_ACTIVATION', installationStatus: 'FAILED', hasUsableInstallData: false, dataUsedMB: 0 })
    expect(d.label).toBe('Installation failed')
    expect(d.tone).toBe('danger')
  })

  it('Provisioned + Installation unavailable → Installation unavailable', () => {
    const d = deriveEsimCustomerDisplayStatus({ status: 'PENDING_ACTIVATION', installationStatus: 'NOT_SUPPORTED', hasUsableInstallData: false, dataUsedMB: 0 })
    expect(d.label).toBe('Installation unavailable')
    expect(d.tone).toBe('warn')
  })

  it('Active + Installed → one "Active" badge (no second Installed badge)', () => {
    const d = deriveEsimCustomerDisplayStatus({ status: 'ACTIVE', installationStatus: 'READY', hasUsableInstallData: true, dataUsedMB: 256 })
    expect(d.label).toBe('Active')
    expect(d.tone).toBe('success')
  })

  it('Active + Installing → Active (service dominates setup)', () => {
    expect(deriveEsimCustomerDisplayStatus({ status: 'ACTIVE', installationStatus: 'PENDING', hasUsableInstallData: false, dataUsedMB: 0 }).label).toBe('Active')
  })

  it('Depleted + Installed → Depleted', () => {
    const d = deriveEsimCustomerDisplayStatus({ status: 'DEPLETED', installationStatus: 'READY', hasUsableInstallData: true, activatedAt: new Date('2026-01-01'), dataUsedMB: 1024 })
    expect(d.label).toBe('Depleted')
    expect(d.tone).toBe('danger')
  })

  it('Suspended + any setup → Suspended', () => {
    expect(deriveEsimCustomerDisplayStatus({ status: 'SUSPENDED', installationStatus: 'READY', hasUsableInstallData: true, dataUsedMB: 0 }).label).toBe('Suspended')
    expect(deriveEsimCustomerDisplayStatus({ status: 'SUSPENDED', installationStatus: 'PENDING', hasUsableInstallData: false, dataUsedMB: 0 }).label).toBe('Suspended')
  })

  it('Expired + any setup → Expired', () => {
    expect(deriveEsimCustomerDisplayStatus({ status: 'EXPIRED', installationStatus: 'READY', hasUsableInstallData: true, dataUsedMB: 0 }).label).toBe('Expired')
    expect(deriveEsimCustomerDisplayStatus({ status: 'EXPIRED', installationStatus: 'PENDING', hasUsableInstallData: false, dataUsedMB: 0 }).label).toBe('Expired')
  })

  it('Failed / Cancelled / Refunded dominate setup', () => {
    expect(deriveEsimCustomerDisplayStatus({ status: 'FAILED', installationStatus: 'READY', hasUsableInstallData: true, dataUsedMB: 0 }).label).toBe('Failed')
    expect(deriveEsimCustomerDisplayStatus({ status: 'CANCELLED', installationStatus: 'READY', hasUsableInstallData: true, dataUsedMB: 0 }).label).toBe('Cancelled')
    expect(deriveEsimCustomerDisplayStatus({ status: 'REFUNDED', installationStatus: 'READY', hasUsableInstallData: true, dataUsedMB: 0 }).label).toBe('Refunded')
  })

  it('never returns Active for PENDING_ACTIVATION solely from install data', () => {
    // QR + install data + READY setup on a pending line still cannot be Active.
    const d = deriveEsimCustomerDisplayStatus({ status: 'PENDING_ACTIVATION', installationStatus: 'READY', hasUsableInstallData: true, qrCode: undefined, dataUsedMB: 0 })
    expect(d.label).not.toBe('Active')
    expect(d.status).toBe('PENDING_ACTIVATION')

    // Even with a QR/activatedAt hint, a non-ACTIVE canonical status stays
    // Provisioned (the display helper never self-derives Active).
    const withEvidence = deriveEsimCustomerDisplayStatus({ status: 'PENDING_ACTIVATION', installationStatus: 'READY', hasUsableInstallData: true, activatedAt: new Date('2026-01-01') })
    expect(withEvidence.label).not.toBe('Active')
    expect(withEvidence.label).toBe('Provisioned')
  })

  it('is deterministic and never mutates input', () => {
    const input = { ...readyRow }
    const a = deriveEsimCustomerDisplayStatus(input)
    const b = deriveEsimCustomerDisplayStatus(input)
    expect(a).toEqual(b)
    expect(input.status).toBe('PENDING_ACTIVATION')
    expect(input.installationStatus).toBe('READY')
  })

  it('deriveEsimCustomerDisplayStatusFromRow matches the direct helper', () => {
    const row = { status: 'ACTIVE', installationStatus: 'READY', hasUsableInstallData: true, activatedAt: new Date('2026-01-01'), dataUsedMB: 512 }
    expect(deriveEsimCustomerDisplayStatusFromRow(row).label).toBe('Active')
    expect(deriveEsimCustomerDisplayStatusFromRow(row)).toEqual(deriveEsimCustomerDisplayStatus(row))
  })
})