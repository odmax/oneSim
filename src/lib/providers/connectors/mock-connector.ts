import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, DiagnosticInfo, EsimLifecycleResult } from './connector-interface'

export class MockConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string

  constructor(providerId: string, name?: string) {
    this.providerId = providerId
    this.name = name || 'Mock Provider'
  }

  async getTokenState(): Promise<import('./connector-interface').TokenState> {
    return { tokenPresent: true, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    return true
  }

  async authenticate(_credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    return { success: true, data: { token: 'mock-token', accountInfo: { env: 'mock' } } }
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    return { success: true, data: { message: 'Mock connection OK', latencyMs: 5 } }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    return {
      success: true,
      data: {
        connectorClass: 'MockConnector',
        method: 'N/A',
        baseUrl: 'N/A',
        authUrl: 'N/A',
        path: 'N/A',
        finalUrl: 'N/A',
        tokenPlacement: 'NONE',
        authType: 'NONE',
        authHeaderPresent: false,
        tokenReplaced: false,
        responseStatus: null,
        responseContentType: null,
        responseBody: null,
        latencyMs: 0,
        warnings: [],
      },
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    return {
      success: true,
      data: [
        { id: 'mock-plan-1', name: 'Mock 1GB', data_gb: 1, validity_days: 7, price_usd: 5, sku: 'MOCK-1GB' },
        { id: 'mock-plan-2', name: 'Mock 5GB', data_gb: 5, validity_days: 30, price_usd: 20, sku: 'MOCK-5GB' },
      ],
    }
  }

  async activateESIM(_params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    return {
      success: true,
      data: { activationId: 'mock-act-1', iccids: ['89000000000000000000'], qrCodeUrl: 'https://mock/qr', status: 'ACTIVATED' },
    }
  }

  async getStatus(_subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    return { success: true, data: { status: 'ACTIVE', iccid: '89000000000000000000' } }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> {
    return { success: true, data: { iccid: '89000000000000000000', dataUsedMB: 0 } }
  }

  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: true, data: { status: 'SUSPENDED', providerStatus: 'suspended' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    return { success: true, data: { status: 'ACTIVE', providerStatus: 'active' } }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: true, data: [] }
  }

  async getQRCode(_iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    return { success: true, data: { qrCodeUrl: 'https://mock/qr' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: true, data: { providerReference: 'mock-topup-ref', dataAddedMB: 1024, validityDaysAdded: 30, status: 'COMPLETED' } }
  }
}
