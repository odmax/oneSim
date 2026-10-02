import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Structural guard audit: every sidebar navigation entry maps to the SAME
 * granular checkbox that gates its destination page. In particular the three
 * Monitoring/Support entries must each reference their own checkbox so one
 * grant cannot leak access to a sibling page:
 *   - Audit Logs  → VIEW_AUDIT_LOGS (page gates VIEW_AUDIT_LOGS)
 *   - API Logs    → VIEW_API_LOGS   (page gates VIEW_API_LOGS)
 *   - Support     → VIEW_SUPPORT    (page gates VIEW_SUPPORT)
 */
describe('admin sidebar — granular per-checkbox navigation gates', () => {
  const layout = readFileSync(path.join(process.cwd(), 'src/app/admin/layout.tsx'), 'utf8')

  it('API Logs sidebar entry references VIEW_API_LOGS (never VIEW_AUDIT_LOGS)', () => {
    expect(layout).toContain("permission: Permissions.VIEW_API_LOGS")
    expect(layout).not.toContain("'API Logs', href: '/admin/api-logs', permission: Permissions.VIEW_AUDIT_LOGS")
    expect(layout).toContain("'/admin/api-logs', permission: Permissions.VIEW_API_LOGS")
  })

  it('Audit Logs sidebar entry references VIEW_AUDIT_LOGS', () => {
    expect(layout).toContain("'/admin/audit-logs', permission: Permissions.VIEW_AUDIT_LOGS")
  })

  it('Support Queue sidebar entry references VIEW_SUPPORT', () => {
    expect(layout).toContain("'/admin/support', permission: Permissions.VIEW_SUPPORT")
  })

  it('Credit Allocations sidebar entry references MANAGE_WALLETS (not the MANAGE_FINANCE alias)', () => {
    expect(layout).toContain("'/admin/wallet-topups', permission: Permissions.MANAGE_WALLETS")
    expect(layout).not.toContain("'MANAGE_FINANCE'")
  })
})