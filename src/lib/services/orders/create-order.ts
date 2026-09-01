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
  idempotencyKey?: string
  /** Pre-requested purchase quote reference (validated/consumed at purchase). */
  quoteReference?: string
  /** Travel date (YYYY-MM-DD) required by plans that mandate it. */
  travelDate?: string
  /** Internal trace correlation ID */
  correlationId?: string
  /**
   * When true, enqueue provider dispatch and return immediately with status
   * PROCESSING (async). The provider activation runs in the background job
   * system; poll GET /api/v1/orders/{orderId} for completion.
   */
  async?: boolean
  /**
   * TRUSTED REQUEST CONTEXT — internal only, never from the public request body.
   * A package already resolved (and tenant/security-validated) by trusted route
   * code before calling createOrder. When present the orchestrator skips its own
   * identical re-resolution; all downstream checks (backing, readiness, price
   * guard, travel date, wallet, provider status) still run unchanged. createOrder
   * is fully safe and canonical when this is absent (all non-API callers).
   */
  resolvedPackage?: {
    id: string
    source?: string | null
    providerId?: string | null
    providerPlanId?: string | null
    providerPackageId?: string | null
    isActive?: boolean | null
    hiddenFromCatalog?: boolean | null
    archivedAt?: Date | null
    name?: string | null
    displayName?: string | null
    sku?: string | null
    packageCode?: string | null
    customerDescription?: string | null
    description?: string | null
    dataGB?: number | null
    validityDays?: number | null
    priceUSD?: any
    localPrice?: any
    currency?: string | null
    providerName?: string | null
    [k: string]: any
  } | null
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
  errorCode?: string
  errorStatus?: number
}

const orchestrator = new PurchaseOrchestrator()

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const execute = params.async ? orchestrator.executePurchaseAsync.bind(orchestrator) : orchestrator.executePurchase.bind(orchestrator)
  const result = await execute({
    businessId: params.businessId,
    userId: params.userId,
    packageId: params.packageId,
    sku: params.sku,
    packageCode: params.packageCode,
    quantity: params.quantity,
    correlationId: params.correlationId,
    customer: params.customer ? {
      name: params.customer.name,
      email: params.customer.email,
      phone: params.customer.phone,
      country: params.customer.country,
      externalId: params.customer.externalId,
    } : undefined,
    callbackUrl: params.callbackUrl,
    idempotencyKey: params.idempotencyKey,
    quoteReference: params.quoteReference,
    travelDate: params.travelDate,
    resolvedPackage: params.resolvedPackage ?? undefined,
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
    console.log(`[PURCHASE_TRACE] step=CREATE_ORDER_FAILED errorCode=${result.errorCode} message=${result.message?.substring(0, 120)}`)
    return { success: false, error: result.message || 'Purchase failed', errorCode: result.errorCode, errorStatus: result.retryable ? 502 : 400 }
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
