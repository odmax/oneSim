import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Structural guard audit: every previously role-only admin route now enforces a
 * DB-backed capability through adminApiAccess. A direct API call therefore
 * cannot bypass the saved permission checkboxes. We assert two invariants per
 * file: an `adminApiAccess(...)` gate is present, and the old
 * `role !== 'INTERNAL_ADMIN'` guard is gone.
 */
const ADMIN_ROUTES = [
  'src/app/api/packages/route.ts',
  'src/app/api/packages/[id]/route.ts',
  'src/app/api/esims/route.ts',
  'src/app/api/esims/[esimId]/qr-download/route.ts',
  'src/app/api/esim/[iccid]/route.ts',
  'src/app/api/esim/purchases/route.ts',
  'src/app/api/businesses/route.ts',
  'src/app/api/businesses/[id]/route.ts',
  'src/app/api/export/analytics-csv/route.ts',
  'src/app/api/export/admin-usage/route.ts',
  'src/app/api/admin/imported-plans-csv/export/route.ts',
  'src/app/api/admin/pricing-csv/export/route.ts',
  'src/app/api/admin/provider-catalog-export/route.ts',
  'src/app/api/admin/provider-catalog-export/xlsx/route.ts',
  'src/app/api/admin/invoices/[id]/pdf/route.ts',
  'src/app/api/admin/catalog-events/route.ts',
  'src/app/api/admin/catalog-events/audit/route.ts',
  'src/app/api/admin/catalog-events/dead-letter/route.ts',
  'src/app/api/admin/catalog-events/dead-letter/[id]/route.ts',
  'src/app/api/admin/catalog-events/diagnostics/route.ts',
  'src/app/api/admin/catalog-events/flow/route.ts',
  'src/app/api/admin/catalog-events/health/route.ts',
  'src/app/api/admin/catalog-events/load-test/route.ts',
  'src/app/api/admin/catalog-events/metrics/route.ts',
  'src/app/api/admin/catalog-events/reconciliation/route.ts',
  'src/app/api/admin/catalog-events/[id]/route.ts',
  'src/app/api/admin/catalog-pipeline/route.ts',
  'src/app/api/admin/catalog-pipeline/runs/route.ts',
  'src/app/api/admin/catalog-pipeline/runs/[id]/route.ts',
  'src/app/api/admin/catalog-pipeline/summary/route.ts',
  'src/app/api/admin/topups/review/route.ts',
  'src/app/api/admin/topups/review/[id]/reconcile/route.ts',
  'src/app/api/admin/providers/maintenance/route.ts',
  'src/app/api/admin/providers/import-plans/route.ts',
]

/** Mutation endpoints must require a MANAGE_* permission; reads require a VIEW_*. */
const EXPECTED_CAPABILITY: Record<string, string[]> = {
  'src/app/api/packages/route.ts': ['VIEW_PACKAGES', 'MANAGE_PACKAGES'],
  'src/app/api/packages/[id]/route.ts': ['VIEW_PACKAGES', 'MANAGE_PACKAGES'],
  'src/app/api/esims/route.ts': ['VIEW_ESIMS'],
  'src/app/api/esims/[esimId]/qr-download/route.ts': ['VIEW_ESIMS'],
  'src/app/api/esim/[iccid]/route.ts': ['VIEW_ESIMS'],
  'src/app/api/esim/purchases/route.ts': ['VIEW_ESIMS'],
  'src/app/api/businesses/route.ts': ['VIEW_BUSINESSES', 'MANAGE_BUSINESSES'],
  'src/app/api/businesses/[id]/route.ts': ['VIEW_BUSINESSES', 'MANAGE_BUSINESSES'],
  'src/app/api/export/analytics-csv/route.ts': ['VIEW_ANALYTICS'],
  'src/app/api/export/admin-usage/route.ts': ['VIEW_ANALYTICS'],
  'src/app/api/admin/imported-plans-csv/export/route.ts': ['VIEW_PROVIDERS'],
  'src/app/api/admin/pricing-csv/export/route.ts': ['VIEW_PRICING'],
  'src/app/api/admin/provider-catalog-export/route.ts': ['VIEW_PROVIDERS'],
  'src/app/api/admin/provider-catalog-export/xlsx/route.ts': ['VIEW_PROVIDERS'],
  'src/app/api/admin/invoices/[id]/pdf/route.ts': ['VIEW_INVOICES'],
  'src/app/api/admin/catalog-events/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-events/audit/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-events/dead-letter/route.ts': ['VIEW_AUDIT_LOGS', 'MANAGE_PRODUCTS'],
  'src/app/api/admin/catalog-events/dead-letter/[id]/route.ts': ['MANAGE_PRODUCTS'],
  'src/app/api/admin/catalog-events/diagnostics/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-events/flow/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-events/health/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-events/load-test/route.ts': ['MANAGE_PRODUCTS'],
  'src/app/api/admin/catalog-events/metrics/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-events/reconciliation/route.ts': ['MANAGE_PRODUCTS'],
  'src/app/api/admin/catalog-events/[id]/route.ts': ['MANAGE_PRODUCTS'],
  'src/app/api/admin/catalog-pipeline/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-pipeline/runs/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-pipeline/runs/[id]/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/catalog-pipeline/summary/route.ts': ['VIEW_AUDIT_LOGS'],
  'src/app/api/admin/topups/review/route.ts': ['MANAGE_WALLETS'],
  'src/app/api/admin/topups/review/[id]/reconcile/route.ts': ['MANAGE_WALLETS'],
  'src/app/api/admin/providers/maintenance/route.ts': ['MANAGE_PROVIDERS'],
  'src/app/api/admin/providers/import-plans/route.ts': ['MANAGE_PROVIDERS'],
}

describe('admin REST routes — DB-backed capability enforcement (no role-only guards)', () => {
  for (const rel of ADMIN_ROUTES) {
    const p = path.join(process.cwd(), rel)
    const content = readFileSync(p, 'utf8')
    const expected = EXPECTED_CAPABILITY[rel] || []

    it(`${rel} enforces adminApiAccess with the expected permission(s)`, () => {
      expect(content).toContain('await adminApiAccess(')
    })

    it(`${rel} no longer uses a bare INTERNAL_ADMIN role-only guard`, () => {
      expect(content).not.toContain("role !== 'INTERNAL_ADMIN'")
    })

    it(`${rel} references the expected capability permission id(s): ${expected.join(',')}`, () => {
      for (const cap of expected) expect(content).toContain(`Permissions.${cap}`)
    })
  }
})