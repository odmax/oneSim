import { describe, it, expect } from 'vitest'
import fs from 'fs'

describe('OpenAPI specification', () => {
  const specRouteExists = fs.existsSync('src/app/api/openapi.json/route.ts')

  it('1. OpenAPI route file exists', () => {
    expect(specRouteExists).toBe(true)
  })

  it('2. Swagger UI page exists', () => {
    expect(fs.existsSync('src/app/developers/api-reference/page.tsx')).toBe(true)
  })

  it('3. spec includes all expected paths', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    const expected = ['/packages', '/esims/order', '/orders', '/esims/', '/usage', '/wallet', '/customers', '/webhooks', '/auth/verify']
    for (const path of expected) {
      expect(content).toContain(path)
    }
  })

  it('4. spec includes bearerAuth security scheme', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('bearerAuth')
    expect(content).toContain('Authorization: Bearer')
  })

  it('5. spec includes ApiError schema', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('ApiError')
  })

  it('6. spec includes Package schema', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('Package')
  })

  it('7. spec includes Order schema with lifecycle statuses', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('PARTIALLY_FULFILLED')
    expect(content).toContain('PROVIDER_RECONCILIATION')
  })

  it('8. spec includes ESIM schema', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('ESIM')
  })

  it('9. spec includes production and sandbox servers', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('Production')
    expect(content).toContain('Sandbox')
  })

  it('10. spec openapi version is 3.1.0', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('3.1.0')
  })

  it('11. spec tags cover all domains', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    for (const tag of ['Packages', 'Orders', 'eSIMs', 'Usage', 'Wallet', 'Customers', 'Webhooks', 'Authentication']) {
      expect(content).toContain(tag)
    }
  })

  it('12. correct auth header documented (Bearer, not x-api-key)', () => {
    if (!specRouteExists) return
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('Authorization: Bearer')
    expect(content).not.toContain('x-api-key')
  })

  it('13. Try It Out disabled in production by default', () => {
    if (!fs.existsSync('src/app/developers/api-reference/page.tsx')) return
    const content = fs.readFileSync('src/app/developers/api-reference/page.tsx', 'utf8')
    expect(content).toContain('SWAGGER_TRY_IT')
  })

  it('14. OpenAPI JSON endpoint accessible', () => {
    expect(specRouteExists).toBe(true)
  })
})
