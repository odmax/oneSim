import { PurchaseOrchestrator } from './purchase-orchestrator'

export interface CreateOrderCustomer {
  name: string
  email: string
  phone?: string
  country?: string
  externalId?: string
}

export interface CreateOrderParams {
  businessId: string
  userId: string
  packageId?: string
  sku?: string
  packageCode?: string
  quantity: number
  customer?: CreateOrderCustomer
  callbackUrl?: string
}

export interface CreateOrderResult {
  success: boolean
  orderId?: string
  customerId?: string
  status?: string
  unitCost?: number
  totalCost?: number
  quantity?: number
  currency?: string
  esims?: Array<{
    id: string
    iccid: string
    imsi?: string | null
    activationCode?: string | null
    status: string
    qrCodeUrl?: string | null
  }>
  error?: string
  errorStatus?: number
}

const orchestrator = new PurchaseOrchestrator()

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const result = await orchestrator.executePurchase({
    businessId: params.businessId,
    userId: params.userId,
    packageId: params.packageId,
    sku: params.sku,
    packageCode: params.packageCode,
    quantity: params.quantity,
    customer: params.customer ? {
      name: params.customer.name,
      email: params.customer.email,
      phone: params.customer.phone,
      country: params.customer.country,
      externalId: params.customer.externalId,
    } : undefined,
    callbackUrl: params.callbackUrl,
  })

  // Fire webhooks (fire-and-forget)
  if (result.orderId) {
    ;(async () => {
      try {
        const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
        if (!result.success) {
          await enqueueBusinessWebhooks(params.businessId, 'order.failed', {
            orderId: result.orderId, packageId: params.packageId, quantity: params.quantity, error: result.message,
          })
        } else {
          await enqueueBusinessWebhooks(params.businessId, 'order.completed', {
            orderId: result.orderId, packageId: params.packageId, quantity: params.quantity,
            totalAmount: result.totalCost, currency: result.currency || 'USD',
            customer: params.customer ? { name: params.customer.name, email: params.customer.email } : null,
            esims: result.esims?.map(e => ({ id: undefined, iccid: e.iccid })) || [],
          })
          await enqueueBusinessWebhooks(params.businessId, 'esim.provisioned', {
            orderId: result.orderId, quantity: params.quantity,
            esims: result.esims?.map(e => ({ id: undefined, iccid: e.iccid, status: 'PENDING_ACTIVATION' })) || [],
          })
        }
      } catch {}
    })()
  }

  if (!result.success) {
    return { success: false, error: result.message || 'Purchase failed', errorStatus: result.retryable ? 502 : 400 }
  }

  return {
    success: true,
    orderId: result.orderId,
    status: result.status,
    unitCost: result.unitCost,
    totalCost: result.totalCost,
    quantity: result.quantity,
    currency: result.currency,
    esims: result.esims,
  }
}
