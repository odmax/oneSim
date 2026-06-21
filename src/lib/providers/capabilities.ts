export interface ProviderCapabilities {
  supportsESIM: boolean
  supportsPlanSync: boolean
  supportsQRCode: boolean
  supportsTopUp: boolean
  supportsRenewals: boolean
  supportsUsage: boolean
  supportsUsageSync: boolean
  supportsSuspend: boolean
  supportsSuspendResume: boolean
  supportsWallet: boolean
  supportsOrderLookup: boolean
  supportsInventory: boolean
  supportsCountryCatalog: boolean
  supportsWebhookPush: boolean
  supportsTemplates: boolean
  supportsBundleTemplates: boolean
  detectedFrom: {
    dbFields: string[]
    endpointMappings: string[]
    enabledCapabilities: string[]
  }
}

const ENDPOINT_ALIASES: Record<string, string[]> = {
  PURCHASE_ESIM: ['PURCHASE_INITIATE', 'PURCHASE_FULFILL', 'CREATE_PACKAGE', 'ORDER_ESIM'],
  GET_PLANS: ['LIST_PLANS', 'PACKAGE_TEMPLATES', 'GET_PACKAGE_TEMPLATES'],
  GET_ACTIVATION_CODE: ['ACTIVATION_CODE', 'GET_QR_CODE', 'QR_CODE'],
  TOP_UP: ['PURCHASE_TOPUP', 'RENEW_ESIM', 'INSERT_RENEW', 'GET_RENEW_DATA'],
  GET_USAGE: ['PACKAGE_USAGE', 'GET_PACKAGES', 'GET_CDRS'],
  SUSPEND_ESIM: ['TERMINATE_PACKAGE'],
  RESUME_ESIM: ['REACTIVATE_ESIM'],
  GET_WALLET: ['WALLET_BALANCE'],
  GET_ORDER_DETAIL: ['GET_ORDER_DETAILS', 'ORDER_DETAILS'],
  GET_INVENTORY: ['GET_INVENTORIES', 'GET_READY_SIMS', 'GET_PARTNER_INVENTORY_COUNT', 'GET_SIM_REGISTRIES'],
  GET_COUNTRIES: ['COUNTRY_REGION_DETAILS', 'GET_COVERAGES', 'GET_COVERAGE_COUNTRIES'],
}

function hasEndpoint(ep: Record<string, string>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (ep[key]) return true
    const aliases = ENDPOINT_ALIASES[key]
    if (aliases?.some(a => ep[a])) return true
  }
  return false
}

export function inferProviderCapabilities(provider: any): ProviderCapabilities {
  const p = provider || {}
  const ep = (p.endpointMappings || {}) as Record<string, string>
  const dbField = (key: string) => p[key] === true
  const enabledCap = (p.enabledCapabilities || {}) as Record<string, boolean>
  const defaultCap = (p.defaultCapabilities || {}) as Record<string, boolean>

  const track: { db: string[]; ep: string[]; en: string[] } = { db: [], ep: [], en: [] }

  const check = (field: string, ...epKeys: string[]): boolean => {
    if (dbField(field)) { track.db.push(field); return true }
    if (enabledCap[field]) { track.en.push(field); return true }
    if (defaultCap[field]) { track.en.push(`defaultCapabilities.${field}`); return true }
    if (hasEndpoint(ep, ...epKeys)) { track.ep.push(epKeys[0]); return true }
    return false
  }

  const caps: ProviderCapabilities = {
    supportsESIM: check('supportsESIM', 'PURCHASE_ESIM'),
    supportsPlanSync: check('supportsPlanSync', 'GET_PLANS'),
    supportsQRCode: check('supportsQRCode', 'GET_ACTIVATION_CODE'),
    supportsTopUp: check('supportsTopUp', 'TOP_UP'),
    supportsRenewals: check('supportsRenewals', 'RENEW_ESIM'),
    supportsUsage: check('supportsUsage', 'GET_USAGE'),
    supportsUsageSync: check('supportsUsageSync', 'GET_USAGE'),
    supportsSuspend: check('supportsSuspend', 'SUSPEND_ESIM'),
    supportsSuspendResume: (() => {
      if (dbField('supportsSuspendResume')) { track.db.push('supportsSuspendResume'); return true }
      if (enabledCap['supportsSuspendResume']) { track.en.push('supportsSuspendResume'); return true }
      if (defaultCap['supportsSuspendResume']) { track.en.push('defaultCapabilities.supportsSuspendResume'); return true }
      if ((ep.SUSPEND_ESIM || ep.TERMINATE_PACKAGE) && (ep.RESUME_ESIM || ep.REACTIVATE_ESIM)) {
        track.ep.push('SUSPEND_ESIM+RESUME_ESIM'); return true
      }
      return false
    })(),
    supportsWallet: check('supportsWallet', 'GET_WALLET'),
    supportsOrderLookup: check('supportsOrderLookup', 'GET_ORDER_DETAIL'),
    supportsInventory: check('supportsInventory', 'GET_INVENTORY'),
    supportsCountryCatalog: check('supportsCountryCatalog', 'GET_COUNTRIES'),
    supportsWebhookPush: check('supportsWebhookPush'),
    supportsTemplates: check('supportsTemplates'),
    supportsBundleTemplates: false,
    detectedFrom: {
      dbFields: [...new Set(track.db)],
      endpointMappings: [...new Set(track.ep)],
      enabledCapabilities: [...new Set(track.en)],
    },
  }

  return caps
}

// For db-backed capabilities that can be written to the Provider model
export const DB_CAPABILITY_KEYS: readonly string[] = [
  'supportsESIM', 'supportsUsage', 'supportsTopUp', 'supportsSuspend',
  'supportsQRCode', 'supportsPools', 'supportsTemplates',
  'supportsUsageSync', 'supportsWebhookPush', 'supportsSuspendResume',
] as const

// For writing detected capabilities to DB during sync
export function getPersistableCapabilities(caps: ProviderCapabilities, provider: any): Record<string, boolean> {
  const updates: Record<string, boolean> = {}
  for (const key of DB_CAPABILITY_KEYS) {
    if (caps[key as keyof ProviderCapabilities] === true && !(provider as any)[key]) {
      updates[key] = true
    }
  }
  return updates
}
