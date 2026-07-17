import type { TelnaPCRProfile, MappedTelnaPCRProfile } from '../connectors/telna-endpoints'

export function mapTelnaPCRProfile(profile: TelnaPCRProfile): MappedTelnaPCRProfile {
  return {
    iccid: profile.iccid,
    status: profile.status || 'UNKNOWN',
    currentPackage: {
      id: profile.current_package?.id != null ? String(profile.current_package.id) : null,
      packageTemplateId: profile.current_package?.package_template_id != null ? String(profile.current_package.package_template_id) : null,
      name: profile.current_package?.name || null,
    },
    pendingPackage: {
      id: profile.pending_package?.id != null ? String(profile.pending_package.id) : null,
      packageTemplateId: profile.pending_package?.package_template_id != null ? String(profile.pending_package.package_template_id) : null,
      name: profile.pending_package?.name || null,
    },
    trafficPolicyId: profile.traffic_policy_id ?? null,
    walletId: profile.wallet_id ?? null,
    activationState: profile.activation_state || null,
    renewal: {
      enabled: profile.renewal?.enabled ?? false,
      renewalDate: profile.renewal?.renewal_date || null,
      renewalPackageId: profile.renewal?.renewal_package_id != null ? String(profile.renewal.renewal_package_id) : null,
    },
    expiration: {
      expired: profile.expiration?.expired ?? false,
      expirationDate: profile.expiration?.expiration_date || null,
    },
    createdAt: profile.created_at || null,
    updatedAt: profile.updated_at || null,
    rawData: profile as Record<string, unknown>,
  }
}
