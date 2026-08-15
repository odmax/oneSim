/**
 * SAFE Choice installation-endpoint inspection (staging/read-only).
 *
 * Purpose: determine, from live read-only responses, whether Choice exposes a
 * non-billable endpoint that returns installation data (activation_code /
 * qr_code_link / lpa / smdp / matchingId) for an EXISTING ICCID.
 *
 * SAFETY:
 * - REQUIRES --iccid. Never prints the full ICCID (masked).
 * - Only GET (read-only) endpoints already implemented in the repo are called:
 *   package_detail, imsis_from_iccid, imsi_version, allocated_imsi_list,
 *   event_logs. NO POST mutations (no activateESIM / topUp / suspend / resume /
 *   add_bundle_using_template_from_pool / purchase).
 * - Prints only keys / array lengths / whitelist-presence booleans — NEVER
 *   values, NEVER the token, NEVER raw bodies.
 *
 * Usage (run on staging with the app's env):
 *   npx ts-node --transpile-only scripts/inspect-choice-installation-endpoints.ts --iccid 8901...
 * Optional: --providerId <id> to target a specific Choice provider.
 */
import { PrismaClient } from '@prisma/client'
import { decryptToken } from '../src/lib/encryption'

const WHITELIST_INSTALL_KEYS = [
  'activation_code', 'activationCode', 'qr_code_link', 'qr_code_url', 'qrCodeUrl',
  'lpa', 'lpaProfile', 'smdp', 'smdp_address', 'smdpAddress', 'matching_id', 'matchingId',
] as const

function maskIccid(iccid: string): string {
  return iccid.length <= 8 ? '****' : `${iccid.slice(0, 4)}••••${iccid.slice(-4)}`
}

function objectKeys(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return []
  return Object.keys(value).slice(0, 30)
}

function arrayLen(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined
}

function whitelistPresent(node: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const key of WHITELIST_INSTALL_KEYS) out[key] = false
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 3) return
    if (Array.isArray(value)) { for (const item of value.slice(0, 10)) walk(item, depth + 1); return }
    for (const key of Object.keys(value)) {
      const record = value as Record<string, unknown>
      if ((WHITELIST_INSTALL_KEYS as readonly string[]).includes(key)) out[key] = Boolean(record[key])
      walk(record[key], depth + 1)
    }
  }
  walk(node, 0)
  return out
}

function summarize(raw: unknown): { topLevelKeys: string[]; packageKeys?: string[]; dataKeys?: string[]; imsisCount?: number; firstImsiKeys?: string[]; eventsCount?: number } {
  const json: any = raw
  const summary: { topLevelKeys: string[]; packageKeys?: string[]; dataKeys?: string[]; imsisCount?: number; firstImsiKeys?: string[]; eventsCount?: number } = {
    topLevelKeys: objectKeys(json),
  }
  if (json?.package && typeof json.package === 'object') summary.packageKeys = objectKeys(json.package)
  if (json?.data && typeof json.data === 'object') {
    summary.dataKeys = objectKeys(json.data)
    summary.imsisCount = arrayLen(json.data.imsis)
    if (Array.isArray(json.data.imsis) && json.data.imsis.length > 0) summary.firstImsiKeys = objectKeys(json.data.imsis[0])
  }
  if (json?.events && Array.isArray(json.events)) summary.eventsCount = json.events.length
  return summary
}

async function probe(name: string, url: string, baseUrl: string, timeoutMs = 20000): Promise<void> {
  const started = Date.now()
  let httpStatus: number | null = null
  let durationMs = 0
  let keys: any = {}
  let whitelist: Record<string, boolean> | null = null
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
    httpStatus = res.status
    const text = await res.text()
    durationMs = Date.now() - started
    let json: any
    try { json = JSON.parse(text) } catch { json = null }
    if (json) {
      keys = summarize(json)
      whitelist = whitelistPresent(json)
    }
  } catch (e: any) {
    durationMs = Date.now() - started
    console.log(JSON.stringify({ endpoint: name, method: 'GET', httpStatus: 'ERROR', durationMs, error: e?.message?.slice(0, 120) }))
    return
  }
  const report: any = { endpoint: name, method: 'GET', httpStatus, durationMs, ...keys }
  if (whitelist) report.installKeysPresent = whitelist
  console.log(JSON.stringify(report))
}

async function main() {
  const args = process.argv.slice(2)
  const iccidArg = args.find(a => a.startsWith('--iccid='))?.split('=')[1] || ''
  const providerIdArg = args.find(a => a.startsWith('--providerId='))?.split('=')[1] || ''
  if (!iccidArg) {
    console.error('Missing required --iccid=<iccid>')
    process.exit(1)
  }
  const iccid = iccidArg.trim()
  const masked = maskIccid(iccid)
  console.log(`[CHOICE_INSPECT] iccid=${masked} providerId=${providerIdArg || '(auto)'}`)

  const prisma = new PrismaClient()
  try {
    const provider = providerIdArg
      ? await prisma.provider.findUnique({ where: { id: providerIdArg } })
      : await prisma.provider.findFirst({ where: { code: 'CHOICE', adapterStrategy: 'CHOICE' } })

    if (!provider || !provider.apiBaseUrl || !provider.apiToken) {
      console.error('Choice provider not found or missing apiBaseUrl/apiToken')
      process.exit(1)
    }

    const base = provider.apiBaseUrl.replace(/\/$/, '')
    const token = decryptToken(provider.apiToken) || ''
    if (!token) { console.error('Cannot decrypt Choice apiToken'); process.exit(1) }
    const encToken = encodeURIComponent(token)

    const endpoints: Array<{ name: string; url: string }> = [
      { name: 'package_detail', url: `${base}/account/v03_09/package_detail/${encToken}?iccid=${encodeURIComponent(iccid)}` },
      { name: 'imsis_from_iccid', url: `${base}/account/v03_09/imsis_from_iccid/${encToken}?iccid=${encodeURIComponent(iccid)}` },
      { name: 'imsi_version', url: `${base}/account/v03_09/imsi_version/${encToken}?iccid=${encodeURIComponent(iccid)}` },
      { name: 'allocated_imsi_list', url: `${base}/account/v03_09/allocated_imsi_list/${encToken}` },
      { name: 'event_logs', url: `${base}/account/v03_09/event_logs/${encToken}?limit=50` },
    ]

    for (const ep of endpoints) {
      await probe(ep.name, ep.url, base)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error('INSPECT FAILED', e?.message?.slice(0, 300)); process.exit(1) })
