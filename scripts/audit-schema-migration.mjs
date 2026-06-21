/**
 * Scans schema.prisma and compares against existing migrations to find missing scalar columns.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const schema = readFileSync('prisma/schema.prisma', 'utf-8')
const migrationDir = 'prisma/migrations'

// Collect all SQL from all migrations
const allSql = readdirSync(migrationDir)
  .sort()
  .flatMap(dir => {
    try { return readFileSync(join(migrationDir, dir, 'migration.sql'), 'utf-8').split('\n') } catch { return [] }
  })
  .join('\n')

// Parse models
const modelRegex = /^model (\w+) \{([^}]+)\}/gm
const models = []
let match
while ((match = modelRegex.exec(schema)) !== null) {
  const name = match[1]
  const body = match[2]
  const tableName = (body.match(/@@map\("([^"]+)"\)/) || [,''])[1] || name.toLowerCase()
  
  // Parse scalar fields only (no relations, no id/createdAt/updatedAt)
  const fieldLines = [...body.matchAll(/^\s{2}(\w+)\s+(.+)$/gm)]
    .filter(f => {
      const type = f[2]
      // Skip relations (end with ? or ! and are model names)
      if (type.match(/^(Boolean|String|Int|Float|DateTime|Decimal|Json|[A-Z]\w+)/)) return true
      return false
    })
    .filter(f => !['id', 'createdAt', 'updatedAt'].includes(f[1]))
  
  // Check Prisma scalar types
  const scalarTypes = ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json']
  const fields = fieldLines
    .map(f => {
      const parts = f[2].trim().split(/\s+/)
      const baseType = parts[0].replace(/[?[\]]/g, '')
      return { name: f[1], type: baseType }
    })
    .filter(f => scalarTypes.includes(f.type) || f.type[0] === f.type[0]?.toUpperCase()) // scalars + enums

  models.push({ name, tableName, fields })
}

const knownMissing = [
  'permissions', 'isActive', 'lastLoginAt',       // internal_admins - already in prod_schema_fix
  'providerPackageId',                               // esim_packages - already in prod_schema_fix
]

console.log('\n=== Missing Scalar Columns Report ===\n')

let totalMissing = 0
const allMissing = []

for (const model of models) {
  const tableRef = `"${model.tableName}"`
  const missingFields = []

  for (const field of model.fields) {
    if (knownMissing.includes(field.name)) continue
    // Check if column exists in ANY migration SQL
    const colPattern = `"${field.name}"`
    // Only check ALTER TABLE or CREATE TABLE for this table
    const relevantSql = allSql
    if (!relevantSql.includes(colPattern)) {
      missingFields.push(field)
    }
  }

  if (missingFields.length > 0) {
    console.log(`\n${model.name} → ${model.tableName}:`)
    for (const f of missingFields) {
      console.log(`  MISSING: ${f.name} (${f.type})`)
      totalMissing++
      allMissing.push({ table: model.tableName, name: f.name, type: f.type })
    }
  }
}

console.log(`\n=== Summary ===`)
console.log(`Total missing scalar fields: ${totalMissing}`)
console.log(`\n=== SQL to Add ===\n`)
for (const m of allMissing) {
  console.log(`ALTER TABLE "${m.table}" ADD COLUMN IF NOT EXISTS "${m.name}" TEXT;`)
}
