export interface SeamlessOSApiResponse<T = any> {
  items?: T[]
  pagination?: { nextCursor?: string | null }
  message?: string
  code?: string
  details?: Array<{ message: string; code: string; property?: string; suggestion?: string }>
  hint?: string
}

export interface SeamlessProductOffering {
  productOfferingId: string
  status: string
  name: string
  description?: string
  customerType?: string
  product?: {
    productId: string
    internalName: string
    type: string
    category?: string
    networkProviderId?: string
    features?: {
      dataMb?: number
      includedCallSeconds?: number
      includedSms?: number
      [key: string]: unknown
    }
  }
  price?: {
    netPrice?: number
    currency?: string
    priceType?: string
    billingCycle?: { period?: string; interval?: number }
  }
  categories?: string[]
  countries?: string[]
  regions?: string[]
  [key: string]: unknown
}

export interface SeamlessOrderLineItem {
  type: string
  lineItemId: string
  productOfferingId: string
  subscriber?: { name?: string; email?: string; address?: any }
  sim?: { esim?: boolean; imei?: string }
  status?: string
  parentLineItemId?: string
  subscriptionId?: string
}

export interface SeamlessOrder {
  orderId: string
  state: string
  customer?: {
    customerId?: string
    name?: string
    newCustomer?: boolean
    customerType?: string
  }
  user?: {
    userId?: string
    name?: string
    newUser?: boolean
  }
  lineItems?: SeamlessOrderLineItem[]
  validation?: { isValid?: boolean; missingFields?: string[] }
  requirements?: {
    requiresPayment?: string
    requiresPaymentProfile?: string
    requiresSigning?: string
  }
  createdEntities?: {
    subscriptions?: Array<{
      subscriptionId: string
      status?: string
      msisdn?: string
      display?: string
      createdByLineItem?: string
    }>
  }
  failureReason?: string
  createdAt?: string
  updatedAt?: string
  expiresAt?: string
  submittedAt?: string
  completedAt?: string
  [key: string]: unknown
}

export interface SeamlessSubscription {
  subscriptionId: string
  status: string
  msisdn?: string
  display?: string
  iccid?: string
  icc?: string
  sim?: { iccid?: string; imsi?: string; [key: string]: unknown }
  subscriber?: { name?: string; email?: string }
  productOfferingId?: string
  createdAt?: string
  [key: string]: unknown
}

export interface SeamlessQRCode {
  qrCodeUrl?: string
  activationCode?: string
  smdpAddress?: string
  matchingId?: string
  lpa?: string
  [key: string]: unknown
}

export interface SeamlessUsage {
  subscriptionId?: string
  dataUsedMb?: number
  dataTotalMb?: number
  dataRemainingMb?: number
  voiceUsedSeconds?: number
  smsUsed?: number
  timestamp?: string
  [key: string]: unknown
}

export interface SeamlessInventorySims {
  iccid?: string
  imsi?: string
  msisdn?: string
  status?: string
  [key: string]: unknown
}

export type SeamlessOrderState = 'PENDING' | 'PENDING_PAYMENT' | 'SUBMITTED' | 'PENDING_APPROVAL' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED'
export type SeamlessSubscriptionState = 'PENDING' | 'ACTIVE' | 'CANCELLED'

export const SEAMLESS_ORDER_STATES: Record<SeamlessOrderState, string> = {
  PENDING: 'Pending',
  PENDING_PAYMENT: 'Pending Payment',
  SUBMITTED: 'Submitted',
  PENDING_APPROVAL: 'Pending Approval',
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  FAILED: 'Failed',
}
