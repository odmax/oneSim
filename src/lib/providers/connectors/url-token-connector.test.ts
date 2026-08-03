import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConnectorResult, ConnectorPlan, ActivateESIMResult, StatusResult, TopUpESIMResult } from './connector-interface'
import { resolveConnectorType, createConnector } from './connector-factory'
import { DEFAULT_PROVIDER_CAPABILITIES } from '../capabilities/defaults'

import { UrlTokenConnector } from './url-token-connector'

function makeChoiceConfig(overrides: any = {}) {
  return {
    apiBaseUrl: overrides.apiBaseUrl ?? 'https://lpaasapi.psasoft.com:443',
    apiToken: overrides.apiToken ?? 'test-token-abc123',
    authUrl: overrides.authUrl ?? 'https://psa.virtuolink.org/WebService/accounts/getaccounts',
    environment: overrides.environment ?? 'staging',
    fieldMappings: overrides.fieldMappings ?? {},
    balancePath: overrides.balancePath,
    currency: overrides.currency,
    timeoutMs: overrides.timeoutMs,
  }
}

function makeConnector(overrides: any = {}) {
  return new UrlTokenConnector('choice-1', 'Choice Wireless', makeChoiceConfig(overrides))
}

function okJson(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

function okXml(xml: string, status = 200) {
  return {
    ok: true,
    status,
    headers: { get: (_: string) => 'text/xml' },
    text: () => Promise.resolve(xml),
  }
}

function errorResponse(status: number, body = '') {
  return {
    ok: false,
    status,
    headers: { get: (_: string) => 'text/plain' },
    text: () => Promise.resolve(body || `HTTP error ${status}`),
  }
}

function networkError(msg = 'fetch failed') {
  return Promise.reject(new Error(msg))
}

const SOAP_ACCOUNTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getaccountsResponse>
      <getaccountsResult>
        <Account>
          <AccountName>Choice Test Account</AccountName>
          <Token>soap-token-xyz</Token>
          <UAID>UA-001</UAID>
          <UserId>user-001</UserId>
        </Account>
      </getaccountsResult>
    </getaccountsResponse>
  </soap:Body>
</soap:Envelope>`

describe('UrlTokenConnector', () => {
  let connector: UrlTokenConnector

  beforeEach(() => {
    vi.clearAllMocks()
    connector = makeConnector()
  })

  describe('constructor and factory', () => {
    it('sets providerId and name', () => {
      expect(connector.providerId).toBe('choice-1')
      expect(connector.name).toBe('Choice Wireless')
    })

    it('CHOICE strategy resolves to URL_TOKEN', () => {
      expect(resolveConnectorType('CHOICE', 'CUSTOM')).toBe('URL_TOKEN')
    })

    it('CHOICE has expected capabilities', () => {
      const caps = DEFAULT_PROVIDER_CAPABILITIES['CHOICE']
      expect(caps).toBeDefined()
      expect(caps).toContain('AUTH')
      expect(caps).toContain('CATALOG_SYNC')
      expect(caps).toContain('PURCHASE')
      expect(caps).toContain('STATUS')
      expect(caps).toContain('BALANCE')
    })

    it('plumbs balancePath, currency, and timeoutMs from provider config into the connector', async () => {
      const c = createConnector('p1', 'Choice', 'URL_TOKEN', {
        apiBaseUrl: 'https://example.com',
        apiToken: 'tok-1',
        config: { balancePath: '/custom/balance', currency: 'GBP', timeoutMs: 9000 },
      }) as unknown as UrlTokenConnector
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: '5.00' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(5)
      expect(result.data?.currency).toBe('GBP')

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://example.com/custom/balance/tok-1')

      vi.unstubAllGlobals()
    })
  })

  describe('authenticate', () => {
    it('succeeds with JSON auth and returns account token', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        response: { status: 0, data: [{ account: '123', accountName: 'Test', token: 'tok-abc', uaid: 'U1', userId: 'U1' }] },
      }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'u', password: 'p' })
      expect(result.success).toBe(true)
      expect(result.data?.token).toBe('tok-abc')
      expect(result.data?.accountInfo?.accounts).toHaveLength(1)

      vi.unstubAllGlobals()
    })

    it('handles accounts from response.data directly', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        data: [{ account: '456', accountName: 'Direct', token: 'tok-direct' }],
      }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'u', password: 'p' })
      expect(result.success).toBe(true)
      expect(result.data?.token).toBe('tok-direct')

      vi.unstubAllGlobals()
    })

    it('falls back to SOAP when JSON auth fails with network error', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('Network down'))
        .mockResolvedValueOnce(okXml(SOAP_ACCOUNTS_XML))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'u', password: 'p' })
      expect(result.success).toBe(true)
      expect(result.data?.token).toBe('soap-token-xyz')
      expect(result.data?.accountInfo?.authDiagnostics?.authMode).toBe('SOAP_USERNAME_PASSWORD')

      vi.unstubAllGlobals()
    })

    it('returns error when JSON returns non-JSON content', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'text/xml' }, text: () => Promise.resolve('<xml>') })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'u', password: 'p' })
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })

    it('returns error for invalid credentials from JSON auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ response: { status: 1, message: 'Invalid credentials' } }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'bad', password: 'bad' })
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AUTH_FAILED')

      vi.unstubAllGlobals()
    })

    it('returns error when zero accounts returned and no network error', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(okJson({ response: { status: 0, data: [] } }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'u', password: 'p' })
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AUTH_FAILED')

      vi.unstubAllGlobals()
    })

    it('returns error on JSON network failure and SOAP also fails', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('Network down'))
        .mockRejectedValueOnce(new Error('SOAP also down'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'u', password: 'p' })
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AUTH_NETWORK_ERROR')

      vi.unstubAllGlobals()
    })

    it('masks tokens in auth diagnostics', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        response: { status: 0, data: [{ account: '123', accountName: 'Test', token: 'very-long-secret-token' }] },
      }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.authenticate({ username: 'u', password: 'p' })
      const masked = result.data?.accountInfo?.authDiagnostics?.maskedTokens?.[0]
      expect(masked).toContain('••••')
      expect(masked).not.toBe('very-long-secret-token')

      vi.unstubAllGlobals()
    })

    it('falls back to parent authenticate when missing credentials', async () => {
      const result = await connector.authenticate({ username: '', password: '' })
      expect(result.success).toBe(true)
      expect(result.data?.token).toBe('test-token-abc123')
    })
  })

  describe('syncPlans', () => {
    it('returns plans from bundle_template_list', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        bundle_template_list: [
          { bundle_name: 'Global 1GB', rate_group_allowance: 1024, rate_group_allow_qtyp: 'MB', rate_group_allow_days: 7, price_usd: 5.99, bundle_template_id: 'bt-1', template_version: 'v1' },
          { bundle_name: 'EU 5GB', rate_group_allowance: 5, rate_group_allow_qtyp: 'GB', rate_group_allow_days: 30, price_usd: 19.99, bundle_template_id: 'bt-2' },
        ],
      }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(2)
      expect(result.data![0].name).toBe('Global 1GB')
      expect(result.data![0].data_gb).toBe(1)
      expect(result.data![0].price_usd).toBe(5.99)
      expect(result.data![0].sku).toBe('bt-1')
      expect(result.data![1].name).toBe('EU 5GB')
      expect(result.data![1].data_gb).toBe(5)

      vi.unstubAllGlobals()
    })

    it('handles empty bundle_template_list', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ bundle_template_list: [] }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(0)

      vi.unstubAllGlobals()
    })

    it('returns zero plans when no matching array in response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ status: 'ok', message: 'no data arrays here' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(0)

      vi.unstubAllGlobals()
    })

    it('returns error on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(500))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('HTTP_500')

      vi.unstubAllGlobals()
    })

    it('returns error on invalid JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: () => Promise.resolve('not valid json {{{'),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INVALID_JSON')

      vi.unstubAllGlobals()
    })

    it('returns error when no base URL', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', { apiBaseUrl: '' })
      const result = await c.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NO_BASE_URL')
    })
  })

  describe('activateESIM — CHOICE_ADD_BUNDLE_FROM_POOL', () => {
    const choiceParams = { planId: 'sku-abc', quantity: 1, subscriber: { email: 'test@test.com' } }

    function makeConnectorWithChoiceFieldMappings() {
      return new UrlTokenConnector('choice-1', 'Choice', makeChoiceConfig({
        fieldMappings: {
          activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL',
          userId: 'onesim',
        },
      }))
    }

    it('returns activation data from data.imsis array', async () => {
      const c = makeConnectorWithChoiceFieldMappings()
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        data: {
          imsis: [
            { iccid: '89012345678901234567', imsi: '310410123456789', activation_code: 'LPA:1$smdp$CODE123', qr_code_link: 'https://qr.example.com/code' },
            { iccid: '89012345678901234568', imsi: '310410123456790', activation_code: 'LPA:1$smdp$CODE456', qr_code_link: '' },
          ],
        },
        transaction_id: 'txn-123',
        status: 'completed',
      }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.activateESIM(choiceParams)
      expect(result.success).toBe(true)
      expect(result.data?.activationId).toBe('txn-123')
      expect(result.data?.iccids).toEqual(['89012345678901234567', '89012345678901234568'])
      expect(result.data?.imsis).toEqual(['310410123456789', '310410123456790'])
      expect(result.data?.activationCodes).toEqual(['LPA:1$smdp$CODE123', 'LPA:1$smdp$CODE456'])
      expect(result.data?.qrCodeUrl).toBe('https://qr.example.com/code')

      vi.unstubAllGlobals()
    })

    it('returns error when no ICCIDs in response', async () => {
      const c = makeConnectorWithChoiceFieldMappings()
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        data: { imsis: [{ imsi: '123' }] },
      }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.activateESIM(choiceParams)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NO_ICCIDS')

      vi.unstubAllGlobals()
    })

    it('sends CHOICE-specific body fields', async () => {
      const c = makeConnectorWithChoiceFieldMappings()
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        data: { imsis: [{ iccid: 'icc-1', imsi: 'imsi-1' }] },
      }))
      vi.stubGlobal('fetch', mockFetch)

      await c.activateESIM(choiceParams)

      const [url, options] = mockFetch.mock.calls[0]
      const body = JSON.parse(options.body)
      expect(body.sku).toBe('sku-abc')
      expect(body.user_id).toBe('onesim')
      expect(body.eu_email_address).toBe('test@test.com')

      vi.unstubAllGlobals()
    })

    it('handles provider-declared failure', async () => {
      const c = makeConnectorWithChoiceFieldMappings()
      const mockFetch = vi.fn().mockResolvedValue(okJson({ success: false, message: 'Insufficient balance' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.activateESIM(choiceParams)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PROVIDER_FAILED')
      expect(result.error?.message).toBe('Insufficient balance')

      vi.unstubAllGlobals()
    })
  })

  describe('activateESIM — generic fallback', () => {
    const genericParams = { planId: 'tmpl-123', quantity: 2, subscriber: { email: 'test@test.com' } }

    it('extracts ICCIDs from multiple response paths', async () => {
      const c = makeConnector()
      const mockFetch = vi.fn().mockResolvedValue(okJson({ iccids: ['icc-a', 'icc-b'], id: 'order-1', status: 'OK' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.activateESIM(genericParams)
      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['icc-a', 'icc-b'])
      expect(result.data?.activationId).toBe('order-1')

      vi.unstubAllGlobals()
    })

    it('extracts single iccid field', async () => {
      const c = makeConnector()
      const mockFetch = vi.fn().mockResolvedValue(okJson({ iccid: 'single-icc', transaction_id: 't1' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.activateESIM(genericParams)
      expect(result.data?.iccids).toEqual(['single-icc'])

      vi.unstubAllGlobals()
    })

    it('extracts ICCID from sim object', async () => {
      const c = makeConnector()
      const mockFetch = vi.fn().mockResolvedValue(okJson({ sim: { iccid: 'sim-icc' } }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.activateESIM(genericParams)
      expect(result.data?.iccids).toEqual(['sim-icc'])

      vi.unstubAllGlobals()
    })
  })

  describe('validatePurchase', () => {
    it('returns valid when activationPayloadType and userId are set', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', makeChoiceConfig({
        fieldMappings: { activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL', userId: 'onesim' },
      }))
      const result = await c.validatePurchase!({ planId: 'sku-1', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(result.valid).toBe(true)
    })

    it('returns invalid when activationPayloadType is missing', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', makeChoiceConfig({
        fieldMappings: {},
      }))
      const result = await c.validatePurchase!({ planId: 'sku-1', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('activationPayloadType')
    })

    it('returns invalid when apiBaseUrl is missing', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', {
        apiBaseUrl: '',
        apiToken: 'tok',
        fieldMappings: { activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL', userId: 'onesim' },
      })
      const result = await c.validatePurchase!({ planId: 'sku-1', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('base URL')
    })

    it('returns invalid when apiToken is missing', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', {
        apiBaseUrl: 'https://api.example.com',
        apiToken: '',
        fieldMappings: { activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL', userId: 'onesim' },
      })
      const result = await c.validatePurchase!({ planId: 'sku-1', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('token')
    })

    it('returns invalid when userId is missing', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', makeChoiceConfig({
        fieldMappings: { activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL' },
      }))
      const result = await c.validatePurchase!({ planId: 'sku-1', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('userId')
    })
  })

  describe('CHOICE body dispatch regression', () => {
    it('sends CHOICE body when fieldMappings have activationPayloadType', async () => {
      const c = new UrlTokenConnector('choice-1', 'Choice', makeChoiceConfig({
        fieldMappings: {
          activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL',
          userId: 'onesim',
        },
      }))
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        data: { imsis: [{ iccid: '89012345678901234567', imsi: '310410123456789' }] },
      }))
      vi.stubGlobal('fetch', mockFetch)

      await c.activateESIM({ planId: 'sku-test-plan', quantity: 1, subscriber: { email: 'test@test.com' } })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.sku).toBe('sku-test-plan')
      expect(body.user_id).toBe('onesim')
      expect(body.eu_email_address).toBe('test@test.com')
      expect(body.template_id).toBeUndefined()
      expect(body.quantity).toBeUndefined()
      expect(body.email).toBeUndefined()

      vi.unstubAllGlobals()
    })

    it('omits eu_email_address when subscriber email is empty', async () => {
      const c = new UrlTokenConnector('choice-1', 'Choice', makeChoiceConfig({
        fieldMappings: {
          activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL',
          userId: 'onesim',
        },
      }))
      const mockFetch = vi.fn().mockResolvedValue(okJson({
        data: { imsis: [{ iccid: '89012345678901234567', imsi: '310410123456789' }] },
      }))
      vi.stubGlobal('fetch', mockFetch)

      await c.activateESIM({ planId: 'sku-a', quantity: 1, subscriber: { email: '' } })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.sku).toBe('sku-a')
      expect(body.user_id).toBe('onesim')
      expect(body.eu_email_address).toBeUndefined()
      expect(body.template_id).toBeUndefined()
      expect(body.email).toBeUndefined()

      vi.unstubAllGlobals()
    })
  })

  describe('getStatus', () => {
    it('returns status and ICCID', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ status: 'ACTIVE', iccid: '89012345678901234567' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('sub-123')
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('ACTIVE')
      expect(result.data?.iccid).toBe('89012345678901234567')

      vi.unstubAllGlobals()
    })

    it('falls back to package_status field', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ package_status: 'EXPIRED' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('sub-123')
      expect(result.data?.status).toBe('EXPIRED')

      vi.unstubAllGlobals()
    })

    it('returns error on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(404))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('nonexistent')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('HTTP_404')

      vi.unstubAllGlobals()
    })
  })

  describe('suspendESIM', () => {
    it('sends POST and returns success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.suspendESIM('sub-123')
      expect(result.success).toBe(true)

      vi.unstubAllGlobals()
    })

    it('returns error on failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(500))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.suspendESIM('sub-123')
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })
  })

  describe('resumeESIM', () => {
    it('sends POST and returns success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.resumeESIM('sub-123')
      expect(result.success).toBe(true)

      vi.unstubAllGlobals()
    })

    it('returns error on failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(500))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.resumeESIM('sub-123')
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })
  })

  describe('topUpESIM', () => {
    it('sends CHOICE_UPDATE_IMSI format', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', makeChoiceConfig({
        fieldMappings: { topUpPayloadType: 'CHOICE_UPDATE_IMSI', userId: 'onesim', topUpOccurrences: 2, topUpAllowDays: 30 },
      }))
      const mockFetch = vi.fn().mockResolvedValue(okJson({ status: 'completed', transaction_id: 'topup-1' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.topUpESIM({ iccid: 'icc-1', planId: 'p1', sku: 'sku-1', quantity: 1 })
      expect(result.success).toBe(true)
      expect(result.data?.providerReference).toBe('topup-1')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.user_id).toBe('onesim')
      expect(body.iccid).toBe('icc-1')
      expect(body.package_name).toBe('sku-1')
      expect(body.top_up_occurrences).toBe(2)

      vi.unstubAllGlobals()
    })

    it('sends generic top-up format', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ status: 'OK', id: 'topup-2' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.topUpESIM({ iccid: 'icc-1', planId: 'p1', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(result.success).toBe(true)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.iccid).toBe('icc-1')
      expect(body.plan_id).toBe('p1')
      expect(body.email).toBe('t@t.com')

      vi.unstubAllGlobals()
    })

    it('returns error on provider failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ status: 'failed', message: 'Balance exceeded' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.topUpESIM({ iccid: 'icc-1', planId: 'p1', quantity: 1 })
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PROVIDER_FAILED')

      vi.unstubAllGlobals()
    })
  })

  describe('getQRCode', () => {
    it('returns NOT_SUPPORTED (QR is inline in purchase)', async () => {
      const result = await connector.getQRCode('any-iccid')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_SUPPORTED')
    })
  })

  describe('getRoamingProfiles', () => {
    it('returns profiles from roaming_profiles endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify([
          { id: 'rp-1', code: 'AIRTEL_UG', name: 'Airtel Uganda', isDefault: true },
          { id: 'rp-2', code: 'MTN_NG', name: 'MTN Nigeria', isDefault: false },
        ])),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getRoamingProfiles!()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(2)
      expect(result.data![0].code).toBe('AIRTEL_UG')
      expect(result.data![0].isDefault).toBe(true)
      expect(result.data![1].code).toBe('MTN_NG')

      vi.unstubAllGlobals()
    })

    it('handles empty response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify([])),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getRoamingProfiles!()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(0)

      vi.unstubAllGlobals()
    })

    it('handles response wrapped in data key', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: [{ code: 'RP1', name: 'Profile 1' }] })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getRoamingProfiles!()
      expect(result.data).toHaveLength(1)
      expect(result.data![0].code).toBe('RP1')

      vi.unstubAllGlobals()
    })

    it('returns error on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(500))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getRoamingProfiles!()
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })
  })

  describe('activateESIM with roaming profile', () => {
    it('includes imsi1_roaming_profile when fieldMapping is set', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', makeChoiceConfig({
        fieldMappings: { activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL', userId: 'onesim', roamingProfileId: 'AIRTEL_UG' },
      }))
      const mockFetch = vi.fn().mockResolvedValue(okJson({ data: { imsis: [{ iccid: 'icc-1', imsi: 'imsi-1' }] } }))
      vi.stubGlobal('fetch', mockFetch)
      await c.activateESIM({ planId: 'sku-test', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).imsi1_roaming_profile).toBe('AIRTEL_UG')
      vi.unstubAllGlobals()
    })

    it('omits imsi1_roaming_profile when fieldMapping is not set', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', makeChoiceConfig({
        fieldMappings: { activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL', userId: 'onesim' },
      }))
      const mockFetch = vi.fn().mockResolvedValue(okJson({ data: { imsis: [{ iccid: 'icc-1', imsi: 'imsi-1' }] } }))
      vi.stubGlobal('fetch', mockFetch)
      await c.activateESIM({ planId: 'sku-test', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).imsi1_roaming_profile).toBeUndefined()
      vi.unstubAllGlobals()
    })

    it('omits imsi1_roaming_profile when roamingProfileId is empty', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', makeChoiceConfig({
        fieldMappings: { activationPayloadType: 'CHOICE_ADD_BUNDLE_FROM_POOL', userId: 'onesim', roamingProfileId: '' },
      }))
      const mockFetch = vi.fn().mockResolvedValue(okJson({ data: { imsis: [{ iccid: 'icc-1', imsi: 'imsi-1' }] } }))
      vi.stubGlobal('fetch', mockFetch)
      await c.activateESIM({ planId: 'sku-test', quantity: 1, subscriber: { email: 't@t.com' } })
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).imsi1_roaming_profile).toBeUndefined()
      vi.unstubAllGlobals()
    })
  })

  describe('getBalance', () => {
    it('returns balance from prepaid_balance endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 1250.50, currency: 'USD' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(1250.50)
      expect(result.data?.currency).toBe('USD')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://lpaasapi.psasoft.com:443/account/v03_09/prepaid_balance/test-token-abc123')
      expect((options.method ?? 'GET').toUpperCase()).toBe('GET')
      expect(options.headers.Accept).toBe('application/json')

      vi.unstubAllGlobals()
    })

    it('puts the token in the URL path, not an Authorization header', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 10 }))
      vi.stubGlobal('fetch', mockFetch)

      await connector.getBalance!()

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers.Authorization).toBeUndefined()
      expect(options.headers.Accept).toBe('application/json')

      vi.unstubAllGlobals()
    })

    it('URL-encodes the token in the path', async () => {
      const c = makeConnector({ apiToken: 'a b+c/d=e&f#g%h' })
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 10 }))
      vi.stubGlobal('fetch', mockFetch)

      await c.getBalance!()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://lpaasapi.psasoft.com:443/account/v03_09/prepaid_balance/a%20b%2Bc%2Fd%3De%26f%23g%25h')

      vi.unstubAllGlobals()
    })

    it('uses a configurable balancePath when provided', async () => {
      const c = makeConnector({ balancePath: '/account/v03_09/wallet_balance' })
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 10 }))
      vi.stubGlobal('fetch', mockFetch)

      await c.getBalance!()

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://lpaasapi.psasoft.com:443/account/v03_09/wallet_balance/test-token-abc123')

      vi.unstubAllGlobals()
    })

    it('never logs the raw token or the full token-bearing URL', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 10, apiToken: 'test-token-abc123' }))
      vi.stubGlobal('fetch', mockFetch)

      await connector.getBalance!()

      const logs = spy.mock.calls.map((c) => String(c[0]))
      expect(logs.some((l) => l.includes('test-token-abc123'))).toBe(false)
      expect(logs.some((l) => l.includes('/account/v03_09/prepaid_balance/test-token-abc123'))).toBe(false)

      spy.mockRestore()
      vi.unstubAllGlobals()
    })

    it('handles balance without currency by falling back to USD', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 500 }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(500)
      expect(result.data?.currency).toBe('USD')

      vi.unstubAllGlobals()
    })

    it('reads prepaid_balance field', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ prepaid_balance: '999.99', currency: 'EUR' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.data?.balance).toBe(999.99)
      expect(result.data?.currency).toBe('EUR')

      vi.unstubAllGlobals()
    })

    it('treats zero as a valid balance', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 0 }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(0)

      vi.unstubAllGlobals()
    })

    it('parses a currency-formatted balance string', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: '$5.00' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(5)
      expect(result.data?.currency).toBe('USD')

      vi.unstubAllGlobals()
    })

    it('finds a numeric balance nested under data or response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ data: { balance: 42 } }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(42)

      vi.unstubAllGlobals()
    })

    it('finds a balance in a single-item array response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson([{ balance: 7 }]))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(7)

      vi.unstubAllGlobals()
    })

    it('parses a JSON-encoded balance string', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ wallet: JSON.stringify({ balance: '12.50' }) }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(12.5)

      vi.unstubAllGlobals()
    })

    it('prefers the response-returned currency over a symbol in the balance', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ currency: 'EUR', balance: '$5.00' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(5)
      expect(result.data?.currency).toBe('EUR')

      vi.unstubAllGlobals()
    })

    it('uses the configured default currency when none is returned', async () => {
      const c = makeConnector({ currency: 'GBP' })
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: '5.00' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(5)
      expect(result.data?.currency).toBe('GBP')

      vi.unstubAllGlobals()
    })

    it('returns CHOICE_BALANCE_FIELD_MISSING for NA/N-A balances', async () => {
      for (const bad of ['NA', 'N/A']) {
        const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: bad }))
        vi.stubGlobal('fetch', mockFetch)
        const result = await connector.getBalance!()
        expect(result.success).toBe(false)
        expect(result.error?.code).toBe('CHOICE_BALANCE_FIELD_MISSING')
        vi.unstubAllGlobals()
      }
    })

    it('returns CHOICE_BALANCE_FIELD_MISSING for non-numeric responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ status: 'ok', message: 'no balance here' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CHOICE_BALANCE_FIELD_MISSING')

      vi.unstubAllGlobals()
    })

    it('maps 401 to CHOICE_AUTH_UNAUTHORIZED', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(401, 'Unauthorized'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CHOICE_AUTH_UNAUTHORIZED')

      vi.unstubAllGlobals()
    })

    it('maps 403 to CHOICE_AUTH_UNAUTHORIZED', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(403, 'Forbidden'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CHOICE_AUTH_UNAUTHORIZED')

      vi.unstubAllGlobals()
    })

    it('maps 404 to CHOICE_BALANCE_ENDPOINT_NOT_FOUND', async () => {
      const mockFetch = vi.fn().mockResolvedValue(errorResponse(404, 'Not Found'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CHOICE_BALANCE_ENDPOINT_NOT_FOUND')

      vi.unstubAllGlobals()
    })

    it('returns CHOICE_BALANCE_NON_JSON when the response is not JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        headers: { get: () => 'text/html' },
        text: () => Promise.resolve('<html>not json</html>'),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CHOICE_BALANCE_NON_JSON')

      vi.unstubAllGlobals()
    })

    it('normalizes network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error('fetch failed'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NETWORK_ERROR')

      vi.unstubAllGlobals()
    })

    it('returns error when no API token, without calling the API', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', { apiBaseUrl: 'https://api.example.com', apiToken: '' })
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CHOICE_CREDENTIALS_MISSING')
      expect(mockFetch).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('returns error when no API base URL', async () => {
      const c = new UrlTokenConnector('c1', 'Choice', { apiBaseUrl: '', apiToken: 'tok' })
      const result = await c.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })

    it('returns error on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('HTTP_500')

      vi.unstubAllGlobals()
    })

    it('logs sanitized diagnostics when CHOICE_BALANCE_DIAGNOSTICS_ENABLED is set', async () => {
      process.env.CHOICE_BALANCE_DIAGNOSTICS_ENABLED = 'true'
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 10, apiToken: 'test-token-abc123' }))
      vi.stubGlobal('fetch', mockFetch)

      await connector.getBalance!()

      const diagLine = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[CHOICE_BALANCE_RESPONSE]'))
      expect(diagLine).toBeDefined()
      expect(diagLine).toContain('httpStatus=200')
      expect(diagLine).toContain('topKeys=')
      expect(diagLine).toContain('balanceFields=')
      expect(diagLine).not.toContain('test-token-abc123')
      expect(diagLine).toContain('[REDACTED]')

      spy.mockRestore()
      delete process.env.CHOICE_BALANCE_DIAGNOSTICS_ENABLED
      vi.unstubAllGlobals()
    })

    it('does not emit CHOICE_BALANCE_RESPONSE diagnostics when disabled', async () => {
      delete process.env.CHOICE_BALANCE_DIAGNOSTICS_ENABLED
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockFetch = vi.fn().mockResolvedValue(okJson({ balance: 10 }))
      vi.stubGlobal('fetch', mockFetch)

      await connector.getBalance!()

      const lines = spy.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.startsWith('[CHOICE_BALANCE_RESPONSE]'))).toBe(false)

      spy.mockRestore()
      vi.unstubAllGlobals()
    })
  })

  describe('getBalance — current_prepaid_balance live shape', () => {
    const live = {
      account_id: '217',
      current_prepaid_balance: 972.6487339312149,
    }

    it('maps the live Choice response without rounding the stored balance', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson(live))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(972.6487339312149)
      expect(result.data?.currency).toBe('USD')
      expect(result.data?.accountId).toBe('217')

      vi.unstubAllGlobals()
    })

    it('uses the configured Choice currency', async () => {
      const c = makeConnector({ currency: 'EUR' })
      const mockFetch = vi.fn().mockResolvedValue(okJson(live))
      vi.stubGlobal('fetch', mockFetch)

      const result = await c.getBalance!()
      expect(result.success).toBe(true)
      expect(result.data?.balance).toBe(972.6487339312149)
      expect(result.data?.currency).toBe('EUR')

      vi.unstubAllGlobals()
    })

    it('does not mistake account_id alone for a balance', async () => {
      const mockFetch = vi.fn().mockResolvedValue(okJson({ account_id: '217' }))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getBalance!()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('CHOICE_BALANCE_FIELD_MISSING')

      vi.unstubAllGlobals()
    })

    it('reports the live field in diagnostics under its own key', async () => {
      process.env.CHOICE_BALANCE_DIAGNOSTICS_ENABLED = 'true'
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockFetch = vi.fn().mockResolvedValue(okJson(live))
      vi.stubGlobal('fetch', mockFetch)

      await connector.getBalance!()

      const diagLine = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[CHOICE_BALANCE_RESPONSE]'))
      expect(diagLine).toBeDefined()
      expect(diagLine).toContain('topKeys=account_id,current_prepaid_balance')
      expect(diagLine).toContain('"current_prepaid_balance":972.6487339312149')

      spy.mockRestore()
      delete process.env.CHOICE_BALANCE_DIAGNOSTICS_ENABLED
      vi.unstubAllGlobals()
    })
  })
})
