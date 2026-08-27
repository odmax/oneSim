/**
 * OneSIM-level kill switch for Custom Package Builder Mode B (UPSTREAM_CREATE).
 *
 * The provider capability/account readiness check is NOT sufficient on its own:
 * before any live upstream mutation may occur, this OneSIM exposure flag must
 * ALSO be explicitly enabled. Default is OFF.
 *
 * Server-side enforced — can never be bypassed via crafted FormData.
 * Mode A is unaffected.
 */
export function isUpstreamCreationExposureEnabled(): boolean {
  return process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED === 'true'
}

/**
 * Server-side gate. Returns a safe error string when upstream creation is
 * globally disabled (kill switch off). Returns null when allowed.
 */
export function upstreamCreationGlobalGate(): string | null {
  if (!isUpstreamCreationExposureEnabled()) {
    return 'Upstream package creation is currently disabled. This capability is off until it is explicitly enabled for your environment.'
  }
  return null
}