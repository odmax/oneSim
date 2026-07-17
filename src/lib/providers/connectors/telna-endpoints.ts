export const TELNA_ENDPOINTS = {
  countries: '/core/countries',
  companies: '/core/companies',
  inventories: '/inventory/inventories',
  groups: '/inventory/groups',
  packageTemplates: '/pcr/package-templates',
  packages: '/pcr/packages',
  simRegistries: '/inventory/sim-registries',
  simProfiles: '/pcr/sim-pcr-profiles',
  wallets: '/pcr/wallets',
  trafficPolicies: '/pcr/traffic-policies',
} as const

export type TelnaEndpoint = keyof typeof TELNA_ENDPOINTS
