export interface PurchaseSnapshot {
  packageId?: string
  displayName?: string
  customerDescription?: string | null
  dataGB?: number
  validityDays?: number
  priceUSD?: number
  currency?: string
  source?: string
  providerName?: string | null
  providerPlanId?: string | null
}

export function getPackageDisplayName(esim?: { packageSnapshot?: any; packageName?: string | null; purchase?: { packageSnapshot?: any; packageName?: string | null; package?: { displayName?: string | null; name?: string } | null } } | null, purchase?: { packageSnapshot?: any; packageName?: string | null; package?: { displayName?: string | null; name?: string } | null } | null): string {
  const snap = esim?.packageSnapshot as PurchaseSnapshot | null
  if (snap?.displayName) return snap.displayName
  if (esim?.packageName) return esim.packageName

  const pSnap = (esim?.purchase?.packageSnapshot || purchase?.packageSnapshot) as PurchaseSnapshot | null
  if (pSnap?.displayName) return pSnap.displayName

  const pName = esim?.purchase?.packageName || purchase?.packageName
  if (pName) return pName

  const pkg = esim?.purchase?.package || purchase?.package
  if (pkg?.displayName) return pkg.displayName
  if (pkg?.name) return pkg.name

  return 'Unknown Package'
}

export function getPackageDataGB(esim?: { packageSnapshot?: any; packageDataGB?: number | null; purchase?: { packageSnapshot?: any; packageDataGB?: number | null; package?: { dataGB?: number } | null } | null }): number {
  const snap = esim?.packageSnapshot as PurchaseSnapshot | null
  if (snap?.dataGB) return snap.dataGB
  if (esim?.packageDataGB) return esim.packageDataGB

  const pSnap = esim?.purchase?.packageSnapshot as PurchaseSnapshot | null
  if (pSnap?.dataGB) return pSnap.dataGB

  if (esim?.purchase?.packageDataGB) return esim.purchase.packageDataGB
  if (esim?.purchase?.package?.dataGB) return esim.purchase.package.dataGB
  return 0
}

export function getPackageValidityDays(esim?: { packageSnapshot?: any; packageValidityDays?: number | null; purchase?: { packageSnapshot?: any; packageValidityDays?: number | null; package?: { validityDays?: number } | null } | null }): number {
  const snap = esim?.packageSnapshot as PurchaseSnapshot | null
  if (snap?.validityDays) return snap.validityDays
  if (esim?.packageValidityDays) return esim.packageValidityDays

  const pSnap = esim?.purchase?.packageSnapshot as PurchaseSnapshot | null
  if (pSnap?.validityDays) return pSnap.validityDays

  if (esim?.purchase?.packageValidityDays) return esim.purchase.packageValidityDays
  if (esim?.purchase?.package?.validityDays) return esim.purchase.package.validityDays
  return 0
}

export function isPackageArchived(pkg?: { hiddenFromCatalog?: boolean | null; archivedAt?: Date | string | null } | null): boolean {
  if (!pkg) return false
  return !!(pkg.hiddenFromCatalog || pkg.archivedAt)
}