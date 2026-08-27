import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Structural regression guard: every executable TypeScript script under
 * src/scripts MUST be a proper module (has at least one top-level import or
 * export). A script without a module boundary is treated by TypeScript as a
 * GLOBAL script: its top-level `const`/`function main` declarations land in the
 * global scope and collide with other global scripts (TS2451 / TS2393 duplicate
 * declarations). This guard keeps scripts isolated so they can be type-checked
 * by `tsc --noEmit` alongside the rest of the repo.
 */
function findScripts(): string[] {
  const dir = path.resolve(process.cwd(), 'src/scripts')
  let files: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) files = files.concat(findScripts())
      else if (e.name.endsWith('.ts')) files.push(path.join(dir, e.name))
    }
  } catch {
    // src/scripts may not exist in some environments — nothing to guard.
  }
  return files
}

describe('src/scripts isolation guard — no global scripts', () => {
  const scripts = findScripts()

  it('found at least the known executable scripts', () => {
    expect(scripts.length).toBeGreaterThan(0)
  })

  it.each(scripts.map(f => [path.relative(process.cwd(), f), f] as const))('%s is a module (has import/export), never a global script', (_rel, file) => {
    const src = readFileSync(file, 'utf8')

    // Module boundary = at least one top-level import or export statement.
    // (require() alone does NOT create a module boundary in TypeScript.)
    const hasModuleBoundary = /(^|\n)\s*(import\s|export\s)/m.test(src)

    expect(
      hasModuleBoundary,
      `Script ${path.basename(file)} has no import/export. Top-level const/function declarations would be GLOBAL and collide (TS2451/TS2393). Add a module boundary (e.g. import statements or "export {}").`,
    ).toBe(true)
  })

  it('no script uses require() without being an ES module', () => {
    for (const file of scripts) {
      const src = readFileSync(file, 'utf8')
      if (/\brequire\(/.test(src)) {
        // require() is only acceptable inside a file that is already a module
        // (has import/export). A plain require-driven global script is forbidden.
        const hasModuleBoundary = /(^|\n)\s*(import\s|export\s)/m.test(src)
        expect(
          hasModuleBoundary,
          `Script ${path.basename(file)} uses require() but has no module boundary — it is a global script.`,
        ).toBe(true)
      }
    }
  })
})