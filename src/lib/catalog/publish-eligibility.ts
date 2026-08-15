/**
 * Publish eligibility — the FIRST gate before a ProviderPackage may ATTEMPT
 * canonical publication (finalize → readiness → publish).
 *
 * A package is eligible to attempt publication when at least one of:
 *   - configurationStatus === 'CONFIGURED'
 *   - configurationStatus === 'AUTO_CONFIGURED'
 *   - publishStatus === 'READY'
 *
 * HIDDEN / ARCHIVED must not be directly republished through manual edit
 * (they need an explicit restore/unarchive flow first). UNCONFIGURED never
 * publishes. DRAFT does not publish unless its configurationStatus is
 * CONFIGURED or AUTO_CONFIGURED.
 *
 * PUBLISHED itself is NOT a prerequisite: this is the source-state check for
 * the CONFIGURED → AUTO_CONFIGURED → READY → PUBLISHED transition.
 *
 * Provider-neutral: no provider-name branches. This gate does NOT replace the
 * canonical finalize / readiness / publish flow — eligible packages must still
 * pass finalizeCatalogPackageConfiguration, getPackagePurchaseReadiness, and
 * publishProviderPackageToRetailCatalog.
 */
export interface PublishEligibilityInput {
  configurationStatus?: string | null
  publishStatus?: string | null
}

export function isPackagePublishEligible({ configurationStatus, publishStatus }: PublishEligibilityInput): boolean {
  // HIDDEN / ARCHIVED require an explicit restore/unarchive workflow first —
  // they are never directly eligible for manual republish.
  if (publishStatus === 'HIDDEN' || publishStatus === 'ARCHIVED') return false
  return (
    configurationStatus === 'CONFIGURED' ||
    configurationStatus === 'AUTO_CONFIGURED' ||
    publishStatus === 'READY'
  )
}

export const PUBLISH_INELIGIBLE_MESSAGE =
  'Package is not eligible for publication. Only CONFIGURED, AUTO_CONFIGURED, or READY packages can be published.'

/** Stable, structured reasons a package failed the eligibility gate. */
export function getPublishIneligibilityReasons({ configurationStatus, publishStatus }: PublishEligibilityInput): string[] {
  if (publishStatus === 'HIDDEN') return ['publishStatus is HIDDEN (restore/unarchive before publishing)']
  if (publishStatus === 'ARCHIVED') return ['publishStatus is ARCHIVED (restore/unarchive before publishing)']
  if (configurationStatus === 'UNCONFIGURED') return ['configurationStatus is UNCONFIGURED (never eligible to publish)']
  return [PUBLISH_INELIGIBLE_MESSAGE]
}
