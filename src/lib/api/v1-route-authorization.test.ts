import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { assertKnownV1ScopePolicy, ROUTE_SCOPE_MAP } from './scopes'

const ROOT = process.cwd()
const V1_DIR = path.join(ROOT, 'src/app/api/v1')

const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD', 'OPTIONS']

function walk(dir: string, base: string): string[] {
  let files: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) files = files.concat(walk(full, base))
    else if (e.name === 'route.ts') files.push(full)
  }
  return files
}

/** Convert a filesystem route path into the URL template with [param] segments. */
function fsPathToRouteTemplate(fsPath: string): string {
  const rel = path.relative(V1_DIR, fsPath)
  const segments = rel.split(path.sep)
  // last segment is route.ts
  segments.pop()
  const routeSegments = segments.map(s => (s.startsWith('[') && s.endsWith(']') ? s : s))
  return `/api/v1/${routeSegments.join('/')}`
}

interface V1RouteHandler {
  method: string
  template: string
  file: string
  line: number
}

function parseHandlers(src: string, file: string): V1RouteHandler[] {
  const handlers: V1RouteHandler[] = []
  for (const method of HTTP_METHODS) {
    const re = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length
      handlers.push({ method, template: fsPathToRouteTemplate(file), file, line })
    }
  }
  return handlers
}

describe('Business V1 route authorization totality (fail-closed)', () => {
  const files = walk(V1_DIR, V1_DIR)
  const handlers = files.flatMap(f => parseHandlers(readFileSync(f, 'utf8'), f))

  it('discovers the expected V1 route files', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it('discovered at least the known HTTP handlers', () => {
    const methods = handlers.map(h => `${h.method} ${h.template}`)
    for (const expected of [
      'GET /api/v1/packages',
      'POST /api/v1/esims/order',
      'POST /api/v1/esims/[p]/refresh-status',
      'POST /api/v1/esims/[p]/refresh-qr',
      'POST /api/v1/esims/[p]/top-up',
      'GET /api/v1/wallet',
      'GET /api/v1/auth/verify',
      'GET /api/v1/esims/[p]/usage',
    ]) {
      // Naormalize discovered templates to [p] before comparing.
      const discovered = methods.map(m => m.replace(/\[[^\]]+\]/g, '[p]'))
      expect(discovered).toContain(expected)
    }
  })

  it('every handler has a registered scope policy OR is explicitly exempt', () => {
    // Build the full set of known policies (protected + bootstrap).
    const known: string[] = [
      ...Object.keys(ROUTE_SCOPE_MAP),
      'GET /api/v1/auth/verify',
      'GET /api/v1/esims/order',
    ]
    // Normalize: policy keys use [id]; fs templates use [esimId]/[orderId]/etc,
    // so we canonicalize both to a generic [p].
    const canonical = (key: string) => key.replace(/\[[^\]]+\]/g, '[p]')
    const knownCanon = new Set(known.map(canonical))

    const missing: string[] = []
    for (const h of handlers) {
      const key = `${h.method} ${h.template}`
      if (!knownCanon.has(canonical(key))) {
        missing.push(`${key} (${path.relative(ROOT, h.file)}:${h.line})`)
      }
    }
    expect(missing, `Handlers without a scope policy:\n${missing.join('\n')}`).toEqual([])
  })

  it('assertKnownV1ScopePolicy accepts every discovered handler', () => {
    for (const h of handlers) {
      // The classifier matches via regex on [param], so it accepts the real
      // [esimId]/[orderId] templates regardless of the [id] placeholder naming.
      const canonicalMethod = h.method as 'GET' | 'POST' | 'PATCH' | 'DELETE'
      expect(() => assertKnownV1ScopePolicy(canonicalMethod, h.template)).not.toThrow()
    }
  })

  it('refresh-qr gates on INSTALLATION exposure (not QR_CODE alone) so install data sans QR image is served', () => {
    const routeSrc = readFileSync(path.join(V1_DIR, 'esims/[esimId]/refresh-qr/route.ts'), 'utf8')
    // The Business route enrichment uses ProviderCapability.INSTALLATION — a
    // provider that returns activationCode/smdp/matchingId without a QR image is
    // still install-data-eligible; QR_CODE alone must not gate the route.
    expect(routeSrc).toContain('ProviderCapability.INSTALLATION')
    expect(routeSrc).toContain('requireRouteScopes')
  })

  it('no Business V1 route ever accepts providerId/providerCode from client input', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // Routes must not read provider identity out of the JSON body/query to pick
      // a provider. (Provider resolution is server-side from purchases/backings.)
      expect(src, `route file ${path.relative(ROOT, f)} reads provider identity from client input`).not.toMatch(/body\.provider(code|Id)?/)
      expect(src, `route file ${path.relative(ROOT, f)} reads provider identity from query params`).not.toMatch(/searchParams\.get\(['"]provider/)
    }
  })
})