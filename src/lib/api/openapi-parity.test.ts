import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { ROUTE_SCOPE_MAP, V1_BOOTSTRAP_ROUTES } from './scopes'

/**
 * OpenAPI ↔ implemented-route parity (anti-drift).
 *
 * Every PUBLIC /api/v1 route (the authoritative scope registry) must be
 * represented in /api/docs/openapi.json for each implemented HTTP method, and
 * every method documented there must actually be implemented. A future public
 * endpoint added without documentation FAILS this test.
 *
 * Public banner GET /api/v1/esims/order (service banner, no business payload)
 * is intentionally exempt from documentation.
 */

const DOC_PATH = 'src/app/api/docs/openapi.json/route.ts'

interface Route { method: string; template: string }

function routeSet(): Route[] {
  const out: Route[] = []
  const push = (key: string, kind: 'protected' | 'bootstrap') => {
    const [method, path] = key.split(' ')
    if (kind === 'bootstrap' && path === '/api/v1/esims/order') return // public banner
    out.push({ method: method.toUpperCase(), template: path })
  }
  for (const k of Object.keys(ROUTE_SCOPE_MAP)) push(k, 'protected')
  for (const k of Object.keys(V1_BOOTSTRAP_ROUTES)) push(k, 'bootstrap')
  return out
}

function normalizePath(template: string): string {
  // Canonicalize ANY path parameter (registry `[id]` vs OpenAPI `{orderId}`) to
  // a single token so names do not cause false drift.
  return template.replace(/\[[^\]]+\]/g, '{p}').replace(/\{[^}]+\}/g, '{p}')
}

/** Extract documented paths → { normalizedPath → methods } from the OpenAPI source. */
function documented(): Map<string, Set<string>> {
  const src = fs.readFileSync(DOC_PATH, 'utf8')
  const map = new Map<string, Set<string>>()
  // Path keys appear as string literals at the paths level: `    '/xxx': {`
  const keyRe = /\n\s{4}'(\/[^']+)':\s*\{/g
  const methodRe = /\n\s{6}(get|post|put|patch|delete):\s*\{/gi
  const keys: Array<{ path: string; start: number }> = []
  let m: RegExpExecArray | null
  while ((m = keyRe.exec(src)) !== null) keys.push({ path: m[1], start: m.index + m[0].length })
  for (let i = 0; i < keys.length; i++) {
    const end = i + 1 < keys.length ? keys[i + 1].start : src.length
    const seg = src.slice(keys[i].start, end)
    const methods = new Set<string>()
    let mm: RegExpExecArray | null
    while ((mm = methodRe.exec(seg)) !== null) methods.add(mm[1].toUpperCase())
    const normalized = keys[i].path.startsWith('/api/v1') ? keys[i].path : `/api/v1${keys[i].path}`
    map.set(normalizePath(normalized), methods)
  }
  return map
}

describe('OpenAPI ↔ implemented public routes parity', () => {
  it('every implemented public route path is present in OpenAPI', () => {
    const doc = documented()
    const missing = routeSet().filter((r) => !doc.has(normalizePath(r.template)))
    expect(missing.map((r) => `${r.method} ${r.template}`)).toEqual([])
  })

  it('every implemented public route METHOD is documented', () => {
    const doc = documented()
    const missing = routeSet().filter((r) => {
      const methods = doc.get(normalizePath(r.template))
      return !methods || !methods.has(r.method)
    })
    expect(missing.map((r) => `${r.method} ${r.template}`)).toEqual([])
  })

  it('no documented route/method exists that is not implemented', () => {
    const implemented = new Map(routeSet().map((r) => [`${r.method} ${normalizePath(r.template)}`, true]))
    const phantom: string[] = []
    for (const [path, methods] of documented()) {
      for (const method of methods) {
        const canonical = method === 'DELETE' || method === 'PATCH' || method === 'PUT' ? method : method
        if (!implemented.has(`${canonical} ${path}`)) phantom.push(`${canonical} ${path}`)
      }
    }
    expect(phantom).toEqual([])
  })
})