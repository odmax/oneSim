import crypto from 'crypto'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, UsageResult, StatusResult, RateResult, DiagnosticInfo, EsimLifecycleResult, QRCodeResult, TopUpESIMParams, TopUpESIMResult, TokenState, ConnectorCapabilities, ConnectorAuthProfile } from '../../src/lib/providers/connectors/connector-interface'
import type { Scenario } from './scenarios'

/**
 * Deterministic fake provider driver â€” replaces ONLY the external provider
 * boundary. No network. Real order/wallet/job/attempt/finalization logic runs
 * unchanged against it. Instance is registered via CONNECTOR_OPERATION_OVERRIDES.
 */
export function iccidForKey(key: string, providerCode: string): string {
  const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
  return `8987${String(providerCode).slice(0, 4)}${h}`.toUpperCase()
}

/** Registry of every fake instance created (for dispatch-counter aggregation). */
export const FAKE_INSTANCES: FakeConnector[] = []
/** Module-global polling sequence so repeated connector construction (each
 *  adapter/status call builds a fresh instance) still advances deterministically. */
const GLOBAL_POLL = new Map<string, number>()

export class FakeConnector implements IProviderConnector {
  readonly providerId: string
  readonly name = 'FakeLoadProvider'
  private scenario: Scenario
  private token = 'fake-token'
  /** Deterministic per-(provider,order) dispatch counter. */
  dispatchSeen = new Map<string, number>()

  constructor(providerId: string, scenario: Scenario) {
    this.providerId = providerId
    this.scenario = scenario
    FAKE_INSTANCES.push(this)
  }

  get code() { return this.providerId }

  capabilities: ConnectorCapabilities = {
    installationLookup: false, installationDataAtPurchase: true, installationLookupHistorical: false,
    statusLookup: true, usageLookup: false, topUp: false, suspend: false, resume: false, balance: true, inventory: true, webhooks: false,
  }
  authProfile: ConnectorAuthProfile = { mode: 'LOGIN_TOKEN', requiresRuntimeAuthentication: true, canVerifyCredentials: true, supportsRefresh: true }

  private key(orderRef: string | null | undefined): string {
    return `${this.providerId}:${String(orderRef ?? 'none')}`
  }
  private markDispatch(orderRef: string | null | undefined): void {
    const k = this.key(orderRef)
    this.dispatchSeen.set(k, (this.dispatchSeen.get(k) ?? 0) + 1)
  }
  private nextPoll(orderRef: string | null | undefined): number {
    const k = this.key(orderRef)
    const n = (GLOBAL_POLL.get(k) ?? 0) + 1
    GLOBAL_POLL.set(k, n)
    return n
  }

  async authenticate(): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> { return { success: true, data: { token: this.token } } }
  async getTokenState(): Promise<TokenState> { return { tokenPresent: true, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null } }
  async ensureAuthenticated(): Promise<ConnectorResult<void>> { return { success: true } }
  async refreshAuthentication(): Promise<boolean> { return true }
  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> { return { success: true, data: { message: 'fake ok', latencyMs: 1 } } }
  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    return { success: true, data: { connectorClass: 'FakeConnector', method: 'POST', baseUrl: 'fake://', authUrl: 'fake://', path: '/', finalUrl: 'fake://', tokenPlacement: 'HEADER', authType: 'bearer_token', authHeaderPresent: true, tokenReplaced: false, responseStatus: 200, responseContentType: 'application/json', responseBody: null, latencyMs: 1, warnings: [] } }
  }
  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> { return { success: true, data: [] } }

  async validatePurchase(): Promise<{ valid: boolean; reason?: string }> { return { valid: true } }
  async getBalance(): Promise<ConnectorResult<{ balance: number | null; currency: string | null }>> { return { success: true, data: { balance: 1000000, currency: 'USD' } } }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const orderRef = params.orderId ?? params.externalId ?? null
    this.markDispatch(orderRef)
    const k = this.key(orderRef)
    const iccid = iccidForKey(k, this.providerId)

    switch (this.scenario) {
      case 'SUCCESS_SYNC':
      case 'DUPLICATE_SUCCESS':
        return { success: true, data: { activationId: orderRef ?? k, iccids: [iccid], imsis: [], activationCodes: [`LPA:1$fake$${k}`], status: 'ACTIVE' } }
      case 'ASYNC_ACCEPTED':
      case 'TIMEOUT_POST_ACCEPT':
      case 'DELAYED_ACTIVE':
        return { success: true, data: { activationId: orderRef ?? k, iccids: [], status: 'PENDING' } }
      case 'LONG_PENDING':
        return { success: true, data: { activationId: orderRef ?? k, iccids: [], status: 'PENDING' } }
      case 'PARTIAL_QUANTITY':
        return { success: true, data: { activationId: orderRef ?? k, iccids: [iccid], status: 'PROCESSING' } }
      case 'EXPLICIT_REJECT':
        return { success: false, error: { code: 'PROVIDER_REJECTED', message: 'fake explicit reject', details: { retryable: false } } }
      case 'RATE_LIMITED':
        return { success: false, error: { code: 'RATE_LIMITED', message: 'fake 429', details: { retryable: true } } }
      case 'HTTP_500':
        return { success: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'fake 500', details: { retryable: true } } }
      case 'TIMEOUT_PRE_ACCEPT':
        return { success: false, error: { code: 'TIMEOUT', message: 'fake pre-accept timeout', details: { ambiguous: true } } }
      case 'MALFORMED_RESPONSE':
        return { success: true, data: { activationId: '', status: 'PROCESSING', iccids: [] } } // no usable identifier → INCOMPLETE_RESPONSE→AMBIGUOUS
      default:
        return { success: true, data: { activationId: orderRef ?? k, iccids: [iccid], status: 'ACTIVE' } }
    }
  }

  async getStatus(identifier: string): Promise<ConnectorResult<StatusResult>> {
    const k = this.key(identifier)
    const iccid = iccidForKey(k, this.providerId)
    const poll = this.nextPoll(identifier)

    switch (this.scenario) {
      case 'LONG_PENDING':
        return { success: true, data: { status: 'PENDING', iccids: [], rawStatus: 'PENDING' } }
      case 'PARTIAL_QUANTITY':
        return { success: true, data: { status: 'ACTIVE', iccids: [iccid], rawStatus: 'ACTIVE' } }
      case 'TIMEOUT_POST_ACCEPT':
        if (poll === 1) return { success: false, error: { code: 'TIMEOUT', message: 'fake transient poll timeout' } }
        return { success: true, data: { status: 'ACTIVE', iccids: [iccid], rawStatus: 'ACTIVE' } }
      case 'DELAYED_ACTIVE':
        if (poll < 3) return { success: true, data: { status: 'PENDING', iccids: [], rawStatus: 'PENDING' } }
        return { success: true, data: { status: 'ACTIVE', iccids: [iccid], rawStatus: 'ACTIVE' } }
      case 'ASYNC_ACCEPTED':
        if (poll < 2) return { success: true, data: { status: 'PENDING', iccids: [], rawStatus: 'PENDING' } }
        return { success: true, data: { status: 'ACTIVE', iccids: [iccid], rawStatus: 'ACTIVE' } }
      default:
        return { success: true, data: { status: 'ACTIVE', iccids: [iccid], rawStatus: 'ACTIVE' } }
    }
  }

  resolveStatusLookup = (): string => '' // provider-operated activation jobs pass providerRef directly
  async getUsage(): Promise<ConnectorResult<UsageResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'not supported' } } }
  async suspendESIM(): Promise<ConnectorResult<EsimLifecycleResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'not supported' } } }
  async resumeESIM(): Promise<ConnectorResult<EsimLifecycleResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'not supported' } } }
  async getRates(): Promise<ConnectorResult<RateResult[]>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'not supported' } } }
  async getQRCode(iccid: string): Promise<ConnectorResult<QRCodeResult>> { return { success: true, data: { qrCodeUrl: `fake://qr/${iccid.slice(-8)}` } } }
  async topUpESIM(): Promise<ConnectorResult<TopUpESIMResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'not supported' } } }
}

export function makeFakeFactory(scenario: Scenario): (providerId: string) => FakeConnector {
  return (providerId: string) => new FakeConnector(providerId, scenario)
}