export function suggestDisplayName(pkg: { dataGB: number; validityDays: number; providerRawData?: any }): string {
  const raw = pkg.providerRawData as Record<string, any> | null | undefined
  const location = raw?.country || raw?.region || raw?.territory || raw?.market || ''
  const locationStr = location ? `${location} ` : ''
  return `OneSIM ${locationStr}${pkg.dataGB}GB ${pkg.validityDays} Days`
}
