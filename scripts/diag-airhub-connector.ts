/**
 * AirHub Connector Diagnostic — Safe, no secrets printed
 *
 * Prints provider code, configured strategy/type, the connector that the
 * normal connector registry resolves, base/auth URL hostnames, environment
 * intent, and whether credentials/token are present (booleans only).
 *
 * Usage: npx tsx scripts/diag-airhub-connector.ts [providerId]
 */
import { PrismaClient } from '@prisma/client'
import { resolveConnectorType } from '../src/lib/providers/connectors/connector-factory'
import { urlHostname, environmentMismatchMessage } from '../src/lib/providers/connectors/airhub-connector'

const prisma = new PrismaClient()

async function main() {
  const providerId = process.argv[2]
  const provider = providerId
    ? await prisma.provider.findUnique({ where: { id: providerId } })
    : await prisma.provider.findFirst({ where: { code: 'AIRHUB' } })

  if (!provider) {
    console.log('No AirHub provider found' + (providerId ? ` for id ${providerId}` : ''))
    process.exit(1)
  }

  const cfg = (provider.config as any) || {}
  const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
  const authPath = provider.authUrl || '/api/Authentication/UserLogin'

  const credentialsPresent =
    ((!!cfg.username || !!cfg.userName) && (!!cfg.password || !!cfg.pass))
  const tokenPresent = !!provider.apiToken

  const resolved = resolveConnectorType(provider.adapterStrategy, provider.type, provider.code)
  const mismatch = environmentMismatchMessage(baseUrl, cfg)

  console.log('=== AirHub Connector Diagnostic ===')
  console.log(`Provider: ${provider.name} (${provider.code}) id=${provider.id} status=${provider.status}`)
  console.log(`type (DB):        ${provider.type}`)
  console.log(`adapterStrategy:  ${provider.adapterStrategy || '(none)'}`)
  console.log(`resolved connector: ${resolved}  ${resolved === 'AIRHUB' ? '(dedicated AirHub connector)' : '(WARNING: NOT the AirHub connector)'}`)
  console.log(`base URL: ${baseUrl}  (host=${urlHostname(baseUrl)})`)
  console.log(`auth URL: ${authPath}  (resolved: ${baseUrl.replace(/\/$/, '')}/${authPath.replace(/^\//, '')})`)
  console.log(`provider.environment:        ${provider.environment || '(none)'}`)
  console.log(`config.upstreamEnvironment:  ${cfg.upstreamEnvironment || '(none)'}`)
  console.log(`config.authEnvironmentAtAuth: ${cfg.authEnvironmentAtAuth || '(none)'}`)
  console.log(`credentials present: ${credentialsPresent} (username=${!!(cfg.username || cfg.userName)} password=${!!(cfg.password || cfg.pass)})`)
  console.log(`token present:      ${tokenPresent}`)
  console.log(`tokenPlacement: ${provider.tokenPlacement || '(none)'}`)
  console.log(`authType: ${provider.authType || '(none)'}`)
  console.log(`partnerCode: ${cfg.partnerCode ?? '(none)'}`)

  if (mismatch) {
    console.log()
    console.log(`ENV MISMATCH: ${mismatch}`)
  } else {
    console.log()
    console.log('ENV check: OK (no upstream intent set, or host matches intent)')
  }

  if (!credentialsPresent && !tokenPresent) {
    console.log()
    console.log('WARNING: neither credentials nor an API token are stored.')
    console.log('Purchase/status calls will fail with AIRHUB_CREDENTIALS_MISSING or NO_TOKEN.')
    console.log('Run: npx tsx scripts/setup-airhub-credentials.ts <providerId>')
  } else if (resolved !== 'AIRHUB') {
    console.log()
    console.log('WARNING: provider will NOT use the dedicated AirHub connector.')
    console.log('Set adapterStrategy=AIRHUB (or code=AIRHUB) so the registry picks the AirHub connector.')
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
