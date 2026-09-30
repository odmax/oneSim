import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('admin eSIM inventory — canonical lifecycle filter + provider-neutral fields', () => {
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

  it('list uses the provider-neutral inventory fields component, not the two-axis presentation', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('EsimInventoryStatusFields')
    expect(content).not.toContain('deriveEsimLifecyclePresentation')
  })

  it('raw provider status stays in its own separate column (provider vocabulary separate)', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('esim.providerStatus')
    expect(content).toContain('Provider Status')
  })

  it('inventory fields are rendered with hideService (Status column already shows lifecycle)', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('hideService')
  })

  it('feeds installation-check, scheduler and usage-check fields', () => {
    const content = fs.readFileSync(pagePath, 'utf8')
    expect(content).toContain('installationLastCheckedAt: esim.installationLastCheckedAt')
    expect(content).toContain('statusNextSyncAt: esim.statusNextSyncAt')
    expect(content).toContain('lastStatusSyncAt: esim.lastStatusSyncAt')
    expect(content).toContain('lastUsageSyncAt: esim.lastUsageSyncAt')
  })
})
