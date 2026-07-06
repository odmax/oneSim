import crypto from 'crypto'

export interface PaymentIntentRequest {
  amount: number
  currency: string
  paymentReference: string
  businessName: string
}

export interface PaymentIntentResult {
  success: boolean
  paymentReference: string
  instructions: string
  providerName: string
  gatewayUrl?: string
  error?: string
}

export interface PaymentVerificationResult {
  success: boolean
  paid: boolean
  gatewayReference?: string
  error?: string
}

export interface PaymentProvider {
  name: string
  createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult>
  verifyPayment(paymentReference: string): Promise<PaymentVerificationResult>
}

export class ManualPaymentProvider implements PaymentProvider {
  name = 'manual'

  async createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    return {
      success: true,
      paymentReference: request.paymentReference,
      instructions: [
        `Bank transfer to OneSIM Africa`,
        `Reference: ${request.paymentReference}`,
        `Amount: $${request.amount.toFixed(2)}`,
        `Bank: OneSIM Financial Services`,
        `Account: 1234567890`,
        `Sort Code: 11-22-33`,
        '',
        `After payment, your account will be credited once admin confirms the transfer.`,
      ].join('\n'),
      providerName: 'Manual Bank Transfer',
    }
  }

  async verifyPayment(paymentReference: string): Promise<PaymentVerificationResult> {
    return { success: true, paid: false }
  }
}

export function generatePaymentReference(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `ONESIM-${ts}-${rand}`
}

let _provider: PaymentProvider | null = null

export function getPaymentProvider(): PaymentProvider {
  if (!_provider) {
    _provider = new ManualPaymentProvider()
  }
  return _provider
}
