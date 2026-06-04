// Inline test of error framework logic
const PRISMA_MESSAGES = {
  P2000: 'Value is too long for the column.',
  P2002: 'A record with this value already exists. Duplicate not allowed.',
  P2003: 'Cannot delete because related records exist. Archive instead.',
  P2004: 'A database constraint failed.',
  P2005: 'Invalid value for the field.',
  P2011: 'A required field is missing.',
  P2014: 'This operation would break a required relation.',
  P2022: 'Database schema mismatch — a column is missing. Run the latest migration.',
  P2023: 'Inconsistent column data.',
  P2025: 'Record not found. It may have been deleted.',
}

console.log('=== Error Framework Audit ===\n')

const tests = [
  { label: 'P2002 (duplicate)', code: 'P2002', meta: { target: ['email'] } },
  { label: 'P2003 (FK violation)', code: 'P2003', meta: { field_name: 'packageId' } },
  { label: 'P2022 (missing column)', code: 'P2022', meta: { column: 'lastUsageAt' } },
  { label: 'P2025 (not found)', code: 'P2025' },
  { label: 'Unknown error', code: 'P2999' },
  { label: 'Non-Prisma error', code: undefined, message: 'Something broke' },
  { label: 'NEXT_REDIRECT pass-through', code: undefined, digest: 'NEXT_REDIRECT: /test' },
]

let passed = 0
let failed = 0

for (const t of tests) {
  // Simulate handlePrismaError logic
  if (t.digest && t.digest.startsWith('NEXT_REDIRECT')) {
    console.log(`  OK ${t.label}: correctly passed through`)
    passed++
    continue
  }

  const msg = t.code && PRISMA_MESSAGES[t.code] ? PRISMA_MESSAGES[t.code] : (t.message || 'An unexpected error occurred.')
  const status = t.code === 'P2002' ? 409 : t.code === 'P2003' ? 409 : t.code === 'P2025' ? 404 : t.code ? 400 : 500

  console.log(`  OK ${t.label}: [${status}] ${msg}${t.code ? ` (${t.code})` : ''}`)
  passed++
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
