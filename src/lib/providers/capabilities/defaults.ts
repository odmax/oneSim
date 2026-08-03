import { ProviderCapability } from './types'

/**
 * Default capability declarations for known provider types/codes.
 * These are used when a provider has no explicit capabilities configured.
 */
export const DEFAULT_PROVIDER_CAPABILITIES: Record<string, ProviderCapability[]> = {
  // Choice — full eSIM lifecycle
  CHOICE: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.STATUS,
    ProviderCapability.USAGE,
    ProviderCapability.BALANCE,
  ],

  // AirHub — full eSIM lifecycle (auth, catalog, purchase, status, QR)
  AIRHUB: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.STATUS,
    ProviderCapability.BALANCE,
  ],

  // Rakuten — full eSIM lifecycle
  RAKUTEN: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.STATUS,
    ProviderCapability.USAGE,
  ],

  // MOCK — everything for testing
  MOCK: Object.values(ProviderCapability),

  // Telna (future) — full eSIM + advanced
  TELNA: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.TOP_UP,
    ProviderCapability.USAGE,
    ProviderCapability.STATUS,
    ProviderCapability.WEBHOOKS,
    ProviderCapability.SMS_MT,
    ProviderCapability.SMS_MO,
    ProviderCapability.WALLET,
    ProviderCapability.INVENTORY,
    ProviderCapability.PCR_PROFILE,
    ProviderCapability.BALANCE,
  ],

  // Telna SeamlessOS — purchase lifecycle (usage/suspend deferred)
  TELNA_SEAMLESS: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.STATUS,
  ],

  // iBASIS — static token auth, inventory + eSIM lifecycle.
  // No BALANCE until a verified wallet endpoint is documented.
  IBASIS: [
    ProviderCapability.AUTH,
    ProviderCapability.INVENTORY,
    ProviderCapability.ESIM,
    ProviderCapability.PLAN_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.STATUS,
    ProviderCapability.SUSPEND,
    ProviderCapability.RESUME,
  ],
}

/**
 * Template provider types that should inherit capabilities.
 */
export const TEMPLATE_CAPABILITIES: Record<string, ProviderCapability[]> = {
  // Default template — basic auth + catalog
  CUSTOM_TEMPLATE: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
  ],
}
