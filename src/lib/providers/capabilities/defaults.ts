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

  // Telna — provider-neutral documented V2.1 surface. Defaults reflect the
  // ACTUAL TelnaConnector capability truth (connector is authoritative):
  // purchase (POST /v2.1/pcr/packages), catalog sync (package-templates),
  // status (sim-registries + euicc-profiles + packages), usage (package
  // instance), inventory (sim-registries), balance (getWallet).
  // NOT declared by the connector: top-up, webhooks, SMS, wallet, PCR-profile
  // mutations — so they are NOT default-enabled. Custom package creation is
  // implemented but intentionally NOT default-enabled (admin/entitlement-gated
  // and needs explicit provider flag, matching capability-state tests).
  TELNA: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.PURCHASE,
    ProviderCapability.USAGE,
    ProviderCapability.STATUS,
    ProviderCapability.BALANCE,
    ProviderCapability.INVENTORY,
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
  // purchase (POST /esims/assign-package), eSIM-level suspend/resume, status
  // (POST /esims/info + location-event-logs evidence), and usage
  // (POST /packages/usage via mobile-detail packageEsims[].id). No top-up,
  // balance or webhooks in the documented client API.
  USMATRIX: [
    ProviderCapability.AUTH,
    ProviderCapability.CATALOG_SYNC,
    ProviderCapability.INVENTORY,
    ProviderCapability.ESIM,
    ProviderCapability.PURCHASE,
    ProviderCapability.STATUS,
    ProviderCapability.USAGE,
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
