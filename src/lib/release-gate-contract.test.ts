import { describe, it, expect } from 'vitest'
import fs from 'fs'

/**
 * Phase 6.4R source-contract regression tests.
 * Guards launch-critical security/UW invariants by asserting on source
 * (mirrors the established content-contract pattern in v1-contract.test.ts).
 */

const read = (rel: string) => fs.readFileSync(rel, 'utf8')

const BUSINESS_ACTION = read('src/lib/actions/business.ts')
const ADMIN_NEW_PAGE = read('src/app/admin/businesses/new/page.tsx')
const INVITE_PAGE = read('src/app/business/users/invite/page.tsx')
const DEV_CLIENT = read('src/app/business/developers/developers-client.tsx')
const TEMPLATE_CLIENT = read('src/app/business/developers/template/TemplateClient.tsx')

describe('P0-3: password never in redirect URL', () => {
  it('createBusiness success redirect carries no password query param', () => {
    const successRedirect = BUSINESS_ACTION.match(/redirect\(`([^`]*\?success=true[^`]*)`\)/)
    expect(successRedirect).not.toBeNull()
    expect(successRedirect![1]).not.toMatch(/password/i)
  })

  it('admin new-business page does not read a password searchParam or render a password value', () => {
    expect(ADMIN_NEW_PAGE).not.toMatch(/searchParams\s*\?\.?\s*\.?\s*password\b|params\s*\.\s*password\b/)
    expect(ADMIN_NEW_PAGE).not.toMatch(/Copy Password|passwordToShare|generatedPassword|\{createdPassword|\{generatedPassword\}/)
  })
})

describe('P0-3: invite flow keeps one-time credential in component state (no URL)', () => {
  it('invite page is a client component that holds credentials in state', () => {
    expect(INVITE_PAGE).toMatch(/^'use client'/)
    expect(INVITE_PAGE).toMatch(/password/)
    expect(INVITE_PAGE).not.toMatch(/useSearchParams/)
    expect(INVITE_PAGE).not.toMatch(/router\.(push|replace)/)
  })
})

describe('P1-4: no alert() in business client UI', () => {
  const BUSINESS_UI_FILES = [
    'src/app/business/esims/ShareActions.tsx',
    'src/app/business/webhooks/WebhooksClient.tsx',
    'src/app/business/developers/developers-client.tsx',
    'src/app/business/buy-esim/PackageBuyCard.tsx',
  ]
  for (const f of BUSINESS_UI_FILES) {
    it(`${f} has no alert()`, () => {
      expect(read(f)).not.toMatch(/\balert\s*\(/)
    })
  }
})

describe('P1-5: provider names not leaked in business developer surfaces', () => {
  for (const [label, content] of [
    ['developers-client', DEV_CLIENT],
    ['template-client', TEMPLATE_CLIENT],
  ] as const) {
    it(`${label} uses capability language, not raw provider names`, () => {
      expect(content).not.toMatch(/\b(Choice|Rakuten|AirHub|iBASIS|Telna)\b/)
    })
  }
})