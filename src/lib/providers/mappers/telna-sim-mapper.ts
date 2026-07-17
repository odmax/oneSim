import type { TelnaSimRegistry, TelnaSimStatus, MappedTelnaSimRegistry } from '../connectors/telna-endpoints'

const TELNA_STATUS_MAP: Record<string, string> = {
  AVAILABLE: 'NOT_SENT',
  ALLOCATED: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  INACTIVE: 'INACTIVE',
  RETIRED: 'RETIRED',
}

export function normalizeSimStatus(providerStatus: string): string {
  return TELNA_STATUS_MAP[providerStatus] || 'UNKNOWN'
}

export function mapTelnaSimRegistry(sim: TelnaSimRegistry): MappedTelnaSimRegistry {
  const providerStatus = sim.status || 'UNKNOWN'
  const status = normalizeSimStatus(providerStatus)

  return {
    iccid: sim.iccid,
    imsi: sim.imsi || null,
    msisdn: sim.msisdn || null,
    inventoryId: sim.inventory_id ?? null,
    groupId: sim.group_id ?? null,
    walletId: sim.wallet_id ?? null,
    currentPackageId: sim.current_package_id != null ? String(sim.current_package_id) : null,
    packageTemplateId: sim.package_template_id != null ? String(sim.package_template_id) : null,
    trafficPolicyId: sim.traffic_policy_id ?? null,
    profileId: sim.pcr_profile_id ?? null,
    activationDate: sim.activation_date || null,
    lastSession: sim.last_session || null,
    providerStatus,
    status,
    normalizedStatus: status,
    createdAt: sim.created_at || null,
    updatedAt: sim.updated_at || null,
    rawData: sim as Record<string, unknown>,
  }
}

export function computeSimComparableKey(iccid: string): string {
  return `sim:iccid:${iccid}`
}
