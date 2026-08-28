/**
 * AirHub Auth Diagnostic — Safe, no credentials exposed
 * Usage: npx tsx scripts/diag-airhub-auth.ts
 */
import { PrismaClient } from '@prisma/client'
import { decryptToken } from '../src/lib/encryption'

const prisma = new PrismaClient()

function mask(s: string | null | undefined): string {
  if (!s) return 'MISSING'
  return `len=${s.length}, first=${s.charAt(0)}, last=${s.charAt(s.length - 1)}`
}

async function main() {
  const provider = await prisma.provider.findFirst({
    where: { code: 'AIRHUB', status: { in: ['ACTIVE', 'TESTING'] } },
    select: { id: true, code: true, name: true, status: true, apiBaseUrl: true, authUrl: true, apiToken: true, config: true, tokenPlacement: true },
  })
  if (!provider) { console.log('No AirHub provider found'); process.exit(1) }

  const cfg = (provider.config as any) || {}

  console.log('=== AirHub Auth Diagnostic ===')
  console.log(`Provider: ${provider.name} (${provider.code}) status=${provider.status}`)
  console.log(`Base URL: ${provider.apiBaseUrl || 'https://api.airhubapp.com'}`)
  console.log(`Auth URL: ${provider.authUrl || '/api/Authentication/UserLogin'}`)
  console.log(`Token placement: ${provider.tokenPlacement || 'N/A'}`)
  console.log(`Has apiToken: ${!!provider.apiToken}`)
  console.log(`Partner code: ${cfg.partnerCode || 'MISSING'}`)
  console.log()

  // Credential source analysis
  const rawUsername = cfg.userName || cfg.username || cfg.user || cfg.apiUser || null
  const rawPassword = cfg.password || cfg.pass || cfg.apiPass || cfg.apiPassword || null

  console.log('=== Credential Sources ===')
  console.log(`userName (cfg.userName):   ${mask(cfg.userName)}`)
  console.log(`userName (cfg.username):   ${mask(cfg.username)}`)
  console.log(`userName (cfg.user):       ${mask(cfg.user)}`)
  console.log(`userName (cfg.apiUser):    ${mask(cfg.apiUser)}`)
  console.log(`FINAL username source:     ${rawUsername ? (cfg.userName ? 'cfg.userName' : cfg.username ? 'cfg.username' : cfg.user ? 'cfg.user' : 'cfg.apiUser') : 'MISSING'}`)
  console.log(`FINAL username:            ${mask(rawUsername)}`)
  console.log()
  console.log(`password (cfg.password):   ${mask(cfg.password)}`)
  console.log(`password (cfg.pass):       ${mask(cfg.pass)}`)
  console.log(`password (cfg.apiPass):    ${mask(cfg.apiPass)}`)
  console.log(`password (cfg.apiPassword): ${mask(cfg.apiPassword)}`)
  console.log(`FINAL password source:     ${rawPassword ? (cfg.password ? 'cfg.password' : cfg.pass ? 'cfg.pass' : cfg.apiPass ? 'cfg.apiPass' : 'cfg.apiPassword') : 'MISSING'}`)
  console.log(`FINAL password:            ${mask(rawPassword)}`)
  console.log()

  if (!rawUsername || !rawPassword) {
    console.log('ERROR: Missing credentials. Add username/password to provider.config.')
    console.log(`Keys present: ${Object.keys(cfg).join(', ')}`)
    process.exit(1)
  }

  // Decrypt apiToken if present
  let decryptedToken = null
  if (provider.apiToken) {
    try { decryptedToken = decryptToken(provider.apiToken) } catch { /* encrypted wrong */ }
    console.log(`apiToken decryption: ${decryptedToken ? `OK (len=${decryptedToken.length})` : 'FAILED'}`)
  }

  // Build the request
  const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
  const authPath = provider.authUrl || '/api/Authentication/UserLogin'
  const url = `${baseUrl.replace(/\/$/, '')}/${authPath.replace(/^\//, '')}`

  console.log()
  console.log('=== Outgoing Request ===')
  console.log(`URL: POST ${url}`)
  console.log(`Headers: Content-Type=application/json, Accept=application/json`)
  console.log(`Body keys: userName, password`)
  console.log(`userName present: ${!!rawUsername}`)
  console.log(`password present: ${!!rawPassword}`)
  console.log()

  // Actually call AirHub
  console.log('=== Live AirHub Response ===')
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ userName: rawUsername, password: rawPassword }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    const text = await response.text()
    console.log(`HTTP ${response.status}`)
    console.log(`Content-Type: ${response.headers.get('content-type') || 'N/A'}`)

    let data: any
    try { data = JSON.parse(text) } catch { console.log(`Raw body (non-JSON): ${text.substring(0, 200)}`) }

    if (data) {
      console.log(`Top keys: ${Object.keys(data).join(', ')}`)
      if (data.errors) {
        const errors = typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors)
        console.log(`Errors: ${errors}`)
      }
      if (data.message) console.log(`Message: ${data.message}`)
      if (data.title) console.log(`Title: ${data.title}`)
      if (data.isSuccess !== undefined) console.log(`isSuccess: ${data.isSuccess}`)
      if (data.token) console.log(`Token present: YES (len=${data.token.length})`)
      // partnerCode may be top-level or nested under data (data.data?.partnerCode).
      const partnerCode = data.partnerCode ?? data.data?.partnerCode ?? null
      if (partnerCode !== null && partnerCode !== undefined && String(partnerCode).trim() !== '') {
        console.log(`partnerCode: ${partnerCode}`)
      }

      // Full sanitized body
      const sanitized = { ...data }
      if (sanitized.token) sanitized.token = `***${data.token.length}chars***`
      if (sanitized.password) sanitized.password = '***REDACTED***'
      console.log(`Full response: ${JSON.stringify(sanitized).substring(0, 500)}`)
    }

    if (response.status === 200 && data?.token) {
      console.log()
      console.log('✅ Authentication SUCCESSFUL')
    } else {
      console.log()
      console.log('❌ Authentication FAILED')
      if (response.status === 400) {
        console.log('Likely cause: Invalid credentials or AirHub validation error.')
        console.log('Check provider.config.username and provider.config.password')
      }
    }
  } catch (e: any) {
    console.log(`Network error: ${e.message}`)
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
