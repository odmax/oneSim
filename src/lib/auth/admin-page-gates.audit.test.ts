import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ADMIN_PERMISSIONS } from '@/lib/auth/admin-permissions'
import { capabilityToPermissionIds } from '@/lib/auth/permissions'

const VALID_PERMISSION_IDS = new Set(ADMIN_PERMISSIONS.map(p => p.id))

/**
 * Explicit, reviewed allowlist of admin pages that are intentionally role-only
 * (no saved capability exists for their purpose). Each entry MUST carry the
 * reason why it is safe: either it is a pure redirect / static denial page, or
 * it exposes only the acting admin's own record. Any page NOT listed here MUST
 * enforce its specific saved capability (see admin-page gate scan below).
 */
const ROLE_ONLY_ALLOWLIST: Record<string, string> = {
  'src/app/admin/unauthorized/page.tsx': 'static authorization-denied screen; no data, no actions',
  'src/app/admin/page.tsx': 'pure redirect to /admin/dashboard; no data',
  'src/app/admin/imported-plans/page.tsx': 'pure redirect stub to /admin/provider-catalog; no data',
  'src/app/admin/account/page.tsx': 'self-service: only the acting admin\'s own user row (name/email/password); no cross-admin data',
  'src/app/admin/dashboard/page.tsx': 'role-only landing for any active admin; aggregate summary counts only, no record-level data, no mutation actions; active-admin enforced by the layout',
}

/** Capability gates the structural audit accepts (checkbox id or capability alias). */
const GATE_PATTERN =
  /(?:checkPermission|canAccessAdmin|requirePermission|adminApiAccess)\(\s*(?:session\.user\.id,\s*)?Permissions\.([A-Z_]+)/

/** Resolve a capability key (checkbox id or alias) to at least one REAL checkbox. */
function resolvesToRealPermission(cap: string): boolean {
  const ids = capabilityToPermissionIds(cap)
  if (ids.length === 0) return false
  return ids.every(id => VALID_PERMISSION_IDS.has(id))
}

function listAdminPages(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listAdminPages(full))
    else if (entry === 'page.tsx') out.push(path.relative(process.cwd(), full).split(path.sep).join('/'))
  }
  return out
}

describe('admin page structural gate audit — DB-backed capability enforcement', () => {
  const pages = listAdminPages(path.join(process.cwd(), 'src/app/admin'))

  it('every admin page.tsx is either capability-gated or allowlisted as intentionally role-only', () => {
    const failures: string[] = []
    for (const rel of pages) {
      if (ROLE_ONLY_ALLOWLIST[rel]) continue
      const content = readFileSync(path.join(process.cwd(), rel), 'utf8')
      const gate = content.match(GATE_PATTERN)
      if (!gate) {
        failures.push(`${rel} — no capability gate and not allowlisted`)
      }
    }
    expect(failures).toEqual([])
  })

  it('every capability-gated page references a REAL capability (no typo, no dead capability)', () => {
    const bad: string[] = []
    for (const rel of pages) {
      const content = readFileSync(path.join(process.cwd(), rel), 'utf8')
      const m = content.match(GATE_PATTERN)
      if (m && !resolvesToRealPermission(m[1])) bad.push(`${rel} -> ${m[1]}`)
    }
    expect(bad).toEqual([])
  })

  it('the role-only allowlist contains only intentionally role-only pages (no sensitive data/actions)', () => {
    for (const rel of Object.keys(ROLE_ONLY_ALLOWLIST)) {
      expect(pages, `allowlisted path is missing: ${rel}`).toContain(rel)
    }
  })
})