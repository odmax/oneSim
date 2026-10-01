import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('admin eSIM inventory — canonical lifecycle filter + provider-neutral status', () => {
  const pagePath = path.join(process.cwd(), 'src/app/admin/esims/page.tsx')

  it('status filter is driven by the canonical lifecycle status list', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('ESIM_LIFECYCLE_STATUSES')
    expect(content).toContain('value={s}')
  })

  it('status filter does not offer the non-canonical INACTIVE value', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).not.toContain('value="INACTIVE"')
    expect(content).not.toContain('>Inactive<')
  })

  it('renders the shared provider-neutral primary badge, not the previous stacked fields or the two-axis presentation', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('EsimPrimaryStatusBadge')
    expect(content).not.toContain('EsimInventoryStatusFields')
    expect(content).not.toContain('deriveEsimLifecyclePresentation')
    expect(content).not.toContain('Usage unavailable')
    expect(content).not.toContain('Installation status unknown')
    expect(content).not.toContain('Status check stopped')
  })

  it('renders exactly one primary status badge per eSIM', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    const rendered = (content.match(/<EsimPrimaryStatusBadge/g) || []).length
    expect(rendered).toBe(1)
  })

  it('raw provider status stays in its own separate admin column (provider vocabulary separate from the customer-facing badge)', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('esim.providerStatus')
    expect(content).toContain('Provider Status')
  })

  it('feeds installation-check, scheduler and usage-check fields to the shared badge', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('installationLastCheckedAt: esim.installationLastCheckedAt')
    expect(content).toContain('statusNextSyncAt: esim.statusNextSyncAt')
    expect(content).toContain('lastStatusSyncAt: esim.lastStatusSyncAt')
    expect(content).toContain('lastUsageSyncAt: esim.lastUsageSyncAt')
  })

  it('the shared badge import is exactly the provider-neutral component used by the business page', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain("from '@/components/esim/EsimPrimaryStatusBadge'")
  })
})