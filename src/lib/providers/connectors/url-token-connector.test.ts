import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConnectorResult, ConnectorPlan, ActivateESIMResult, StatusResult, TopUpESIMResult } from './connector-interface'
import { resolveConnectorType } from './connector-factory'
import { DEFAULT_PROVIDER_CAPABILITIES } from '../capabilities/defaults'

import { UrlTokenConnector } from './url-token-connector'

function makeChoiceConfig(overrides: any = {}) {
  return {
    apiBaseUrl: overrides.apiBaseUrl ?? 'https://lpaasapi.psasoft.com:443',
    apiToken: overrides.apiToken ?? 'test-token-abc123',
    authUrl: overrides.authUrl ?? 'https://psa.virtuolink.org/WebService/accounts/getaccounts',
    environment: overrides.environment ?? 'staging',
    fieldMappings: overrides.fieldMappings ?? {},
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
})
