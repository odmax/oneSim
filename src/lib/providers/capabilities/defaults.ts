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
    ProviderCapability.SUSPEND,
    ProviderCapability.RESUME,
    ProviderCapability.BALANCE,
    ProviderCapability.CREATE_BUNDLE,
    ProviderCapability.UPDATE_BUNDLE,
    ProviderCapability.LIST_BUNDLES,
    ProviderCapability.EVENT_LOGS,
    ProviderCapability.RATE_LIST,
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

  // Telna Connect Flex (ppo-api.telna.com/v1) — read-only surface only (purchase
  // via POST /v1/ordering/work-orders is declared but NOT wired).
  TELNA_FLEX: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.USAGE,
  ],

  // US-Matrix eSIM API — runtime LOGIN_TOKEN auth, catalog + inventory +
  // purchase (POST /esims/assign-package), eSIM-level suspend/resume. Usage is
  // NOT advertised: POST /packages/usage requires packageEsimId, which is not
  // returned by any documented response. No status lifecycle, top-up, balance
  // or webhooks in the documented client API.
  USMATRIX: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.INVENTORY,
    ProviderCapability.ESIM,
    ProviderCapability.PURCHASE,
    ProviderCapability.SUSPEND,
    ProviderCapability.RESUME,
  ],

  // iBASIS — static token auth, inventory + eSIM lifecycle.
  // No BALANCE until a verified wallet endpoint is documented.
  // IBASIS lacks BALANCE (no wallet concept), USAGE, TOP_UP (Phase 2 stubs)
  IBASIS: [
    ProviderCapability.AUTH,
    ProviderCapability.INVENTORY,
    ProviderCapability.ESIM,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.PLAN_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.STATUS,
    ProviderCapability.SUSPEND,
    ProviderCapability.RESUME,
    ProviderCapability.WEBHOOKS,
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
