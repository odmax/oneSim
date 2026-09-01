import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { classifyLoadDb } from './load-db'
import { assertLoadDbBinding } from './bootstrap'

const DIR = path.join(__dirname)
const ALLOWED_STATIC_UTIL = new Set([
  'scenarios.ts', 'metrics.ts', 'open-loop.ts', 'bootstrap.ts', 'load-db.ts', 'telemetry.ts', 'fake-provider-driver.ts',
])
// Entrypoints that must never statically import anything that can pull src/prisma.
const ENTRYPOINTS = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !ALLOWED_STATIC_UTIL.has(f) && !f.startsWith('vitest.'))

describe('HARNESS DB-BINDING SAFETY', () => {
  it('1. no runnable entrypoint statically imports src/{prisma,services,…} or orchestrator-harness', () => {
    const leaks: string[] = []
    for (const f of ENTRYPOINTS) {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8')
      const lines = src.split(/\r?\n/)
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('import ') &&
          (t.includes("'../src/") || t.includes('"./src/') || t.includes("'@/") || t.includes('"./orchestrator-harness"') || t.includes("'./orchestrator-harness'"))) {
          leaks.push(`${f}: ${t}`)
        }
      }
    }
    expect(leaks).toEqual([])
  })

  it('2. override/use with dev URL is blocked (cannot seed/purchase into dev)', () => {
    const gate = classifyLoadDb('postgresql://u:p@localhost:5432/onesim_africa')
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('onesim_load_')
  })

  it('3. bootstrap only ever targets onesim_load_* names (never the maintenance/dev DB)', () => {
    // load-db's classify rejects every non-load name; provision builds targets from the prefix.
    expect(classifyLoadDb('postgresql://u:p@localhost:5432/onesim_load_xyz').ok).toBe(true)
    expect(classifyLoadDb('postgresql://u:p@localhost:5432/onesim_africa').ok).toBe(false)
    expect(classifyLoadDb('postgresql://u:p@staging.example.com:5432/onesim_load_x').ok).toBe(false)
    expect(classifyLoadDb('postgresql://u:p@prod.example.com:5432/onesim_load_x').ok).toBe(false)
  })

  it('4. HARNESS_DB_MISBIND stops when singleton DB != intended load DB', () => {
    expect(() => assertLoadDbBinding('onesim_africa', 'onesim_load_abc')).toThrow('HARNESS_DB_MISBIND')
    expect(() => assertLoadDbBinding('onesim_africa', 'onesim_africa')).not.toThrow()
    expect(() => assertLoadDbBinding('onesim_load_abc', 'onesim_load_abc')).not.toThrow()
  })

  it('5. cleanup/drop is only ever applied to onesim_load_* databases', () => {
    const gate = classifyLoadDb('postgresql://u:p@localhost:5432/onesim_load_dropme')
    expect(gate.ok).toBe(true)
    expect(gate.databaseName.startsWith('onesim_load_')).toBe(true)
    // Non-load names never pass the gate, so they can never reach a DROP path.
    expect(classifyLoadDb('postgresql://u:p@localhost:5432/onesim_africa').ok).toBe(false)
  })
})