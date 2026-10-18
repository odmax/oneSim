import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { effectivePermissions } from '@/lib/auth/permissions'

describe('Admin User edit page — explicit stored permissions are preserved', () => {
  it('uses effectivePermissions (stored arrays verbatim; role defaults only for null)', () => {
    const content = readFileSync(path.join(process.cwd(), 'src/app/admin/users/[id]/edit/page.tsx'), 'utf8')
    expect(content).toContain('effectivePermissions(String(adminUser.role), adminUser.permissions)')
    // DEFAULT_PERMISSIONS is no longer used to collapse an explicit [] to role defaults.
    expect(content).not.toContain('DEFAULT_PERMISSIONS')
  })

  it('an explicit empty array renders and saves as [] for a non-super role', () => {
    expect(effectivePermissions('ADMIN', [])).toEqual([])
    expect(effectivePermissions('SUPPORT_AGENT', [])).toEqual([])
  })

  it('role defaults still apply only to legacy null/undefined stored permissions', () => {
    expect(effectivePermissions('SUPPORT_AGENT', null)).toEqual(
      ['VIEW_BUSINESSES', 'VIEW_ORDERS', 'VIEW_ESIMS', 'VIEW_SUPPORT'],
    )
  })
})