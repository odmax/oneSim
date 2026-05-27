export interface ActivateRequest {
  iccid?: string
  bundleId: string
  orderId: string
  msisdn?: string
  metadata?: Record<string, unknown>
}

export interface ActivateResponse {
  iccid: string
  activationCode: string
  orderId: string
  status: string
  rawResponse?: unknown
}

export interface StatusResponse {
  iccid: string
  status: string
  dataUsedMb?: number
  dataTotalMb?: number
  expiryDate?: string
  rawResponse?: unknown
}

export interface TopUpResponse {
  iccid: string
  bundleId: string
  status: string
  rawResponse?: unknown
}

export type WebhookEventType =
  | 'esim.activated'
  | 'esim.status_changed'
  | 'esim.topup_completed'
  | 'esim.deactivated'
  | 'esim.expired'

export interface WebhookEvent {
  type: WebhookEventType
  iccid: string
  status?: string
  timestamp: Date
  rawPayload: unknown
}

export interface IProviderAdapter {
  readonly providerSlug: string
  activateESim(req: ActivateRequest): Promise<ActivateResponse>
  getStatus(iccid: string): Promise<StatusResponse>
  topUp(iccid: string, bundleId: string): Promise<TopUpResponse>
  deactivate(iccid: string): Promise<void>
  parseWebhook(payload: unknown, headers: Record<string, string>): WebhookEvent
}
