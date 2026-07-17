export const TELNA_ENDPOINTS = {
  countries: '/core/countries',
  company: '/core/companies/{company_id}',
  companies: '/core/companies',
  inventories: '/inventory/inventories',
  groups: '/inventory/groups',
  packageTemplates: '/pcr/package-templates',
  packageTemplate: '/pcr/package-templates/{package_template_id}',
  packages: '/pcr/packages',
  package: '/pcr/packages/{package_id}',
  simRegistries: '/inventory/sim-registries',
  simProfiles: '/pcr/sim-pcr-profiles',
  wallet: '/pcr/wallets/{wallet_id}',
  wallets: '/pcr/wallets',
  trafficPolicies: '/pcr/traffic-policies',
} as const

export type TelnaEndpoint = keyof typeof TELNA_ENDPOINTS

export interface TelnaPaginatedResponse<T> {
  data: T[]
  total: number
  offset: number
  count: number
}

export interface TelnaCountry {
  id: number
  name: string
  iso: string
  code?: string
  region?: string
  flag?: string
}

export interface TelnaCompany {
  id: number
  name: string
  code: string
  status: string
  type?: string
  countryId?: number
  taxId?: string
  address?: string
  phone?: string
  email?: string
}

export interface TelnaInventory {
  id: number
  name: string
  type: string
  status: string
  companyId: number
  totalSims: number
  availableSims: number
  allocatedSims: number
  defectiveSims: number
  testSims: number
}

export interface TelnaGroup {
  id: number
  name: string
  inventoryId: number
  status: string
  profileId?: number
  totalSims: number
  availableSims: number
  allocatedSims: number
}

export interface TelnaWallet {
  id: number
  name: string
  currency: string
  balance: number
  status: string
  companyId: number
  type?: string
  minimumBalance?: number
  maximumBalance?: number
  lastTransactionDate?: string
}

// ── Package Template DTOs (Telna Phase 2A) ──────────────────────────────

export interface TelnaTimeAllowance {
  value: number
  unit: 'DAY' | 'WEEK' | 'MONTH' | 'CALENDAR_MONTH' | 'HOUR' | string
}

export interface TelnaDataAllowance {
  value: number
  unit: 'MB' | 'GB' | 'TB' | 'UNLIMITED' | string
}

export interface TelnaPriceInfo {
  amount: number
  currency: string
  type?: 'FIXED' | 'RECURRING' | string
  billingPeriod?: TelnaTimeAllowance
}

export interface TelnaCoverageZone {
  id?: number
  name?: string
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  countryCodes?: string[]
  type?: 'GLOBAL' | 'REGIONAL' | 'LOCAL' | string
}

export interface TelnaPackageTemplate {
  id: string | number
  name: string
  description?: string
  type?: string
  status?: string
  inventory_id?: string | number
  package_type?: string
  currency?: string
  price?: number | TelnaPriceInfo
  charging?: {
    type?: string
    amount?: number
    currency?: string
    billing_period?: TelnaTimeAllowance
  }
  data_allowance?: TelnaDataAllowance
  voice_allowance?: TelnaDataAllowance
  sms_allowance?: TelnaDataAllowance
  time_allowance?: TelnaTimeAllowance
  speed_allowance?: TelnaDataAllowance
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  zones?: TelnaCoverageZone[]
  traffic_policy_id?: string | number
  route_policy_id?: string | number
  recurring?: {
    enabled?: boolean
    period?: TelnaTimeAllowance
    renewal_price?: number
  }
  coverage_type?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface TelnaPackageTemplateDetail {
  id: string | number
  name: string
  description?: string
  type?: string
  status?: string
  inventory_id?: string | number
  package_type?: string
  currency?: string
  price?: number | TelnaPriceInfo
  charging?: {
    type?: string
    amount?: number
    currency?: string
    billing_period?: TelnaTimeAllowance
  }
  data_allowance?: TelnaDataAllowance
  voice_allowance?: TelnaDataAllowance
  sms_allowance?: TelnaDataAllowance
  time_allowance?: TelnaTimeAllowance
  speed_allowance?: TelnaDataAllowance
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  zones?: TelnaCoverageZone[]
  traffic_policy_id?: string | number
  route_policy_id?: string | number
  recurring?: {
    enabled?: boolean
    period?: TelnaTimeAllowance
    renewal_price?: number
  }
  coverage_type?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface MappedTelnaPackageTemplate {
  providerTemplateId: string
  name: string
  description: string | null
  inventoryId: number | null
  status: string
  currency: string
  providerCost: number | null
  dataAllowance: { value: number; unit: string } | null
  dataBytes: number | null
  dataMB: number | null
  dataGB: number | null
  unlimitedData: boolean
  timeAllowance: { value: number; unit: string } | null
  validityDays: number | null
  countries: string[]
  countryCodes: string[]
  regions: string[]
  trafficPolicyId: string | null
  routePolicyId: string | null
  warnings: string[]
  rawData: Record<string, unknown>
}

// ── Package DTOs (Telna Phase 2B) ──────────────────────────────────────

export interface TelnaPackage {
  id: string | number
  package_template_id?: string | number
  inventory_id?: string | number
  name?: string
  status?: string
  data_allowance?: TelnaDataAllowance
  time_allowance?: TelnaTimeAllowance
  price?: number | TelnaPriceInfo
  currency?: string
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  zones?: TelnaCoverageZone[]
  traffic_policy_id?: string | number
  route_policy_id?: string | number
  wallet_id?: string | number
  activation_mode?: string
  coverage_type?: string
  type?: string
  description?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface MappedTelnaPackage {
  providerPackageId: string
  providerTemplateId: string | null
  name: string
  status: string
  currency: string
  costPrice: number | null
  dataGB: number | null
  dataBytes: number | null
  validityDays: number | null
  country: string | null
  region: string | null
  countryCodes: string[]
  coverageType: string | null
  planType: string | null
  isAvailable: boolean
  warnings: string[]
  rawData: Record<string, unknown>
}
