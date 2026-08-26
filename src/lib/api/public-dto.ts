/**
 * Centralized public DTO serializers for /api/v1 responses.
 *
 * Design principle: ALLOWLISTS only. A Prisma object must NEVER be returned
 * directly from a public API route. Each serializer explicitly names every
 * field that may appear in the public response.
 */

/* -------------------------------------------------------------------------- */
/*  Package DTO                                                               */
/* -------------------------------------------------------------------------- */

export type PublicPackageDTO = {
  id: string
  sku: string | null
  packageCode: string | null
  displayName: string | null
  name: string
  customerDescription: string | null
  description: string | null
  dataGB: number
  validityDays: number
  unitPrice: number
  currency: string
  country: string | null
  region: string | null
  productType: string
  isActive: boolean
  requiresTravelDate: boolean
  source: string
}

export function serializePublicPackage(pkg: any, providerPackage?: any): PublicPackageDTO {
  const unitPrice = parseFloat(pkg.priceUSD.toString())
  return {
    id: pkg.id,
    sku: pkg.sku ?? null,
    packageCode: pkg.packageCode ?? null,
    displayName: pkg.displayName ?? null,
    name: pkg.name,
    customerDescription: pkg.customerDescription ?? null,
    description: pkg.description ?? null,
    dataGB: pkg.dataGB,
    validityDays: pkg.validityDays,
    unitPrice,
    currency: pkg.currency || 'USD',
    country: providerPackage?.country ?? null,
    region: providerPackage?.region ?? null,
    productType: pkg.productType,
    isActive: pkg.isActive,
    requiresTravelDate: !!pkg.requiresTravelDate,
    source: pkg.source,
  }
}

/* -------------------------------------------------------------------------- */
/*  Order (Purchase) DTO                                                      */
/* -------------------------------------------------------------------------- */

export type PublicOrderDTO = {
  id: string
  status: string
  quantity: number
  unitCost: number
  totalCost: number
  currency: string
  createdAt: string
  updatedAt: string
  fulfilledQuantity: number
  failedQuantity: number
  callbackUrl: string | null
  travelDate: string | null
  package: PublicOrderPackageDTO
  esims: PublicOrderEsimDTO[]
}

export type PublicOrderPackageDTO = {
  id: string
  displayName: string
  dataGB: number
  validityDays: number
  priceUSD: number
  currency: string
}

export type PublicOrderEsimDTO = {
  id: string
  iccid: string
  imsi: string | null
  status: string
  expiresAt: string | null
  dataUsedMB: number | null
  dataRemainingMB: number | null
}

export function serializePublicOrder(purchase: any): PublicOrderDTO {
  const snap = purchase.packageSnapshot ?? null
  const pkg = purchase.package
  const pkgInfo: PublicOrderPackageDTO = snap ? {
    id: snap.packageId || pkg.id,
    displayName: snap.displayName || purchase.packageName || pkg.displayName || pkg.name,
    dataGB: snap.dataGB || purchase.packageDataGB || pkg.dataGB,
    validityDays: snap.validityDays || purchase.packageValidityDays || pkg.validityDays,
    priceUSD: snap.priceUSD || parseFloat(pkg.priceUSD.toString()),
    currency: snap.currency || purchase.packageCurrency || pkg.currency || 'USD',
  } : {
    id: pkg.id,
    displayName: purchase.packageName || pkg.displayName || pkg.name,
    dataGB: purchase.packageDataGB || pkg.dataGB,
    validityDays: purchase.packageValidityDays || pkg.validityDays,
    priceUSD: parseFloat(pkg.priceUSD.toString()),
    currency: purchase.packageCurrency || pkg.currency || 'USD',
  }

  const unitPrice = snap?.priceUSD
    || (purchase.packageUnitPrice
      ? parseFloat(purchase.packageUnitPrice.toString())
      : parseFloat(pkg.priceUSD.toString()))

  return {
    id: purchase.id,
    status: purchase.status,
    quantity: purchase.quantity,
    unitCost: unitPrice,
    totalCost: parseFloat(purchase.totalAmount.toString()),
    currency: snap?.currency || purchase.packageCurrency || pkg.currency || 'USD',
    createdAt: purchase.createdAt?.toISOString?.() ?? purchase.createdAt,
    updatedAt: purchase.updatedAt?.toISOString?.() ?? purchase.updatedAt,
    fulfilledQuantity: purchase.fulfilledQuantity ?? 0,
    failedQuantity: purchase.failedQuantity ?? 0,
    callbackUrl: purchase.callbackUrl ?? null,
    travelDate: purchase.resolvedTravelDate ?? purchase.requestedTravelDate ?? null,
    package: pkgInfo,
    esims: (purchase.esims || []).map(serializePublicOrderEsim),
  }
}

function serializePublicOrderEsim(e: any): PublicOrderEsimDTO {
  return {
    id: e.id,
    iccid: e.iccid,
    imsi: e.imsi ?? null,
    status: e.status,
    expiresAt: e.expiresAt?.toISOString?.() ?? e.expiresAt ?? null,
    dataUsedMB: e.dataUsedMB ?? null,
    dataRemainingMB: e.dataRemainingMB ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/*  eSIM Detail DTO                                                           */
/* -------------------------------------------------------------------------- */

export type PublicEsimDetailDTO = {
  id: string
  iccid: string
  imsi: string | null
  status: string
  statusLabel: string
  qrCodeUrl: string | null
  qrCode: string | null
  qrPayload: string | null
  qrKind: string
  activationCode: string | undefined
  smdpAddress: string | undefined
  matchingId: string | undefined
  activatedAt: Date | null
  activationDetectedAt: Date | null
  lastUsageAt: Date | null
  expiresAt: Date | null
  dataUsedMB: number
  dataRemainingMB: number | null
  dataTotalMB: number | null
  package: PublicEsimPackageDTO
  usageRecords: PublicUsageRecordDTO[]
  activationInstructions: string
  sharedAt: Date | null
  sharedToEmail: string | null
  lastStatusSyncAt: Date | null
}

export type PublicEsimPackageDTO = {
  id: string
  displayName: string
  dataGB: number
  validityDays: number
  unitCost: number
  currency: string
}

/* -------------------------------------------------------------------------- */
/*  Usage Record DTO                                                          */
/* -------------------------------------------------------------------------- */

export type PublicUsageRecordDTO = {
  dataUsedMB: number
  dataTotalMB: number | null
  dataRemainingMB: number | null
  timestamp: string
}

export function serializePublicUsageRecord(r: any): PublicUsageRecordDTO {
  return {
    dataUsedMB: r.dataUsedMB,
    dataTotalMB: r.dataTotalMB ?? null,
    dataRemainingMB: r.dataRemainingMB ?? null,
    timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
  }
}

/* -------------------------------------------------------------------------- */
/*  eSIM List Item DTO (for /usage list)                                      */
/* -------------------------------------------------------------------------- */

export type PublicUsageEsimDTO = {
  id: string
  iccid: string
  imsi: string | null
  status: string
  expiresAt: string | null
  dataUsedMB: number | null
  dataRemainingMB: number | null
  dataTotalMB: number | null
  package: { id: string; displayName: string; dataGB: number; validityDays: number }
  lastUsage: PublicUsageRecordDTO | null
  lastUsageSyncAt: string | null
}

export function serializePublicUsageEsim(e: any): PublicUsageEsimDTO {
  return {
    id: e.id,
    iccid: e.iccid,
    imsi: e.imsi ?? null,
    status: e.status,
    expiresAt: e.expiresAt?.toISOString?.() ?? null,
    dataUsedMB: e.dataUsedMB ?? null,
    dataRemainingMB: e.dataRemainingMB ?? null,
    dataTotalMB: e.dataTotalMB ?? null,
    package: {
      id: e.purchase.package.id,
      displayName: e.purchase.package.displayName || e.purchase.package.name,
      dataGB: e.purchase.package.dataGB,
      validityDays: e.purchase.package.validityDays,
    },
    lastUsage: e.usageRecords?.[0] ? serializePublicUsageRecord(e.usageRecords[0]) : null,
    lastUsageSyncAt: e.lastUsageSyncAt?.toISOString?.() ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/*  Wallet Transaction DTO                                                    */
/* -------------------------------------------------------------------------- */

export type PublicWalletTransactionDTO = {
  id: string
  type: string
  amount: number
  description: string | null
  createdAt: string
}

export function serializePublicWalletTransaction(tx: any): PublicWalletTransactionDTO {
  return {
    id: tx.id,
    type: tx.type,
    amount: parseFloat(tx.amount.toString()),
    description: tx.description ?? null,
    createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : tx.createdAt,
  }
}

/* -------------------------------------------------------------------------- */
/*  Customer DTO                                                              */
/* -------------------------------------------------------------------------- */

export type PublicCustomerDTO = {
  id: string
  name: string
  email: string
  phone: string | null
  country: string
  status: string
  createdAt: Date
}

export function serializePublicCustomer(c: any): PublicCustomerDTO {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone ?? null,
    country: c.country,
    status: c.status,
    createdAt: c.createdAt,
  }
}

/* -------------------------------------------------------------------------- */
/*  Customer Detail DTO (with counts)                                         */
/* -------------------------------------------------------------------------- */

export type PublicCustomerDetailDTO = PublicCustomerDTO & {
  esimCount: number
  topUpCount: number
}

export function serializePublicCustomerDetail(c: any): PublicCustomerDetailDTO {
  return {
    ...serializePublicCustomer(c),
    esimCount: c._count?.esims ?? 0,
    topUpCount: c._count?.esimTopUps ?? 0,
  }
}

/* -------------------------------------------------------------------------- */
/*  Webhook DTO                                                               */
/* -------------------------------------------------------------------------- */

export type PublicWebhookDTO = {
  id: string
  name: string
  url: string
  status: string
  events: string[]
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  failureCount: number
  createdAt: Date
}

export function serializePublicWebhook(e: any): PublicWebhookDTO {
  return {
    id: e.id,
    name: e.name,
    url: e.url,
    status: e.status,
    events: e.events,
    lastSuccessAt: e.lastSuccessAt ?? null,
    lastFailureAt: e.lastFailureAt ?? null,
    failureCount: e.failureCount ?? 0,
    createdAt: e.createdAt,
  }
}

/* -------------------------------------------------------------------------- */
/*  Webhook Delivery DTO                                                      */
/* -------------------------------------------------------------------------- */

export type PublicWebhookDeliveryDTO = {
  id: string
  eventType: string
  status: string
  attempts: number
  responseCode: number | null
  errorMessage: string | null
  createdAt: Date
  sentAt: Date | null
}

export function serializePublicWebhookDelivery(d: any): PublicWebhookDeliveryDTO {
  return {
    id: d.id,
    eventType: d.eventType,
    status: d.status,
    attempts: d.attempts,
    responseCode: d.responseCode ?? null,
    errorMessage: d.errorMessage ?? null,
    createdAt: d.createdAt,
    sentAt: d.sentAt ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/*  Forbidden field detection                                                 */
/* -------------------------------------------------------------------------- */

const FORBIDDEN_FIELD_PATTERNS = [
  /^provider/i,
  /^costPrice/i,
  /^costStatus/i,
  /^pricingStatus/i,
  /^publishStatus/i,
  /^configurationStatus/i,
  /^activePriceSnapshotId$/i,
  /^sellingPrice$/i,
  /^rawData$/i,
  /^keyHash$/i,
  /^credentials$/i,
  /^accessToken$/i,
  /^refreshToken$/i,
  /^password$/i,
  /^secret$/i,
  /^rawPayload$/i,
  /^packageSnapshot$/i,
  /^pricingEngineVersion$/i,
  /^businessId$/i,
  /^userId$/i,
  /^previousStatus$/i,
  /^statusChangedAt$/i,
  /^capture[Aa]mount$/i,
  /^released[Aa]mount$/i,
  /^refunded[Aa]mount$/i,
  /^purchaseQuoteId$/i,
  /^packagePriceSnapshotId$/i,
  /^providerMapping$/i,
  /^costPriceUSD$/i,
  /^markupPercent$/i,
  /^costCurrency$/i,
  /^providerSubscriberId$/i,
  /^providerMetadata$/i,
]

export function findForbiddenFields(obj: any, path = ''): string[] {
  const leaks: string[] = []
  if (obj === null || obj === undefined || typeof obj !== 'object') return leaks

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      leaks.push(...findForbiddenFields(item, `${path}[${i}]`))
    })
    return leaks
  }

  for (const key of Object.keys(obj)) {
    const currentPath = path ? `${path}.${key}` : key
    if (FORBIDDEN_FIELD_PATTERNS.some(p => p.test(key))) {
      leaks.push(currentPath)
    }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      leaks.push(...findForbiddenFields(obj[key], currentPath))
    }
  }

  return leaks
}
