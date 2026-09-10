import type { TelnaPCRProfile, MappedTelnaPCRProfile } from '../connectors/telna-endpoints'

function nullableString(value: unknown): string | null {
  return value != null && String(value).trim() !== '' ? String(value) : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// V2.1 SIM PCR profile mapping. The documented profile document (GET/PUT
// /v2.1/pcr/sim-pcr-profiles/{iccid}) carries the SIM identity under `sim`
// (NOT `iccid`) plus data/voice/sms signal states, wallet_mode, wallets and
// route_policy — and NO package identity. This mapper therefore exposes
// subscriber/network state ONLY and never resolves a provider package-instance
// reference (C): there is no currentPackage/pendingPackage output by design.
export function mapTelnaPCRProfile(profile: TelnaPCRProfile): MappedTelnaPCRProfile {
  const data = profile.data
  const wallets = Array.isArray(profile.wallets) ? profile.wallets : []
  const routePolicy = profile.route_policy
  const routePolicyId =
    routePolicy != null && typeof routePolicy === 'object'
      ? nullableString((routePolicy as { id?: unknown }).id)
      : nullableString(routePolicy)
  return {
    sim: nullableString(profile.sim) ?? '',
    dataState: nullableString(data?.state),
    activeThrottling: nullableString(data?.active_throttling),
    voiceState: nullableString(profile.voice?.state),
    smsState: nullableString(profile.sms?.state),
    walletMode: nullableString(profile.wallet_mode),
    wallets: wallets.map((w) => ({
      id: nullableString(w?.id),
      walletType: nullableString(w?.wallet_type),
      ownerInventory: nullableString(w?.owner?.inventory),
      ownerGroup: nullableString(w?.owner?.group),
      ownerSim: nullableString(w?.owner?.sim),
      balance: nullableNumber(w?.balance),
      overdraft: nullableNumber(w?.overdraft),
    })),
    routePolicyId,
    rawData: profile as Record<string, unknown>,
  }
}
