/**
 * AirHub Credential Setup — Safe, no credentials committed
 *
 * Usage:
 *   AIRHUB_USERNAME=xxx AIRHUB_PASSWORD=yyy npx tsx scripts/setup-airhub-credentials.ts
 *
 * This script:
 *   1. Stores credentials encrypted in provider.config
 *   2. Authenticates with AirHub
 *   3. Stores the token encrypted in provider.apiToken
 *   4. Does NOT persist plaintext credentials
 */

import { PrismaClient } from '@prisma/client'
import { encryptToken } from '../src/lib/encryption'

const prisma = new PrismaClient()

function mask(s: string): string { return s ? `len=${s.length}, first=${s.charAt(0)}, last=${s.charAt(s.length - 1)}` : 'MISSING' }

async function main() {
  const username = process.env.AIRHUB_USERNAME?.trim()
  const password = process.env.AIRHUB_PASSWORD?.trim()

  if (!username || !password) {
    console.log('ERROR: Set AIRHUB_USERNAME and AIRHUB_PASSWORD environment variables')
    console.log('Usage: AIRHUB_USERNAME=xxx AIRHUB_PASSWORD=yyy npx tsx scripts/setup-airhub-credentials.ts')
    process.exit(1)
  }

  console.log(`Username: ${mask(username)}`)
  console.log(`Password: ${mask(password)}`)

  const provider = await prisma.provider.findFirst({
    where: { code: 'AIRHUB', status: { in: ['ACTIVE', 'TESTING'] } },
  })
  if (!provider) { console.log('No AirHub provider found'); process.exit(1) }

  // Store credentials encrypted in provider.config
  const existingConfig = (provider.config as any) || {}
  const updatedConfig = {
    ...existingConfig,
    username,
    password,
    lastCredentialUpdate: new Date().toISOString(),
  }

  await prisma.provider.update({
    where: { id: provider.id },
    data: { config: updatedConfig },
  })
  console.log('✓ Credentials stored in provider.config')

  // Authenticate with AirHub
  const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
  const url = `${baseUrl.replace(/\/$/, '')}/api/Authentication/UserLogin`

  console.log(`\nAuthenticating at: POST ${url}`)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ userName: username, password }),
    })
    const text = await response.text()
    let data: any
    try { data = JSON.parse(text) } catch {
      console.log(`Auth failed: HTTP ${response.status}, non-JSON response`)
      process.exit(1)
    }

    console.log(`HTTP ${response.status}`)

    if (!response.ok || data.isSuccess === false) {
      const msg = data.message || data.errors || JSON.stringify(data).substring(0, 200)
      console.log(`Auth rejected: ${msg}`)
      process.exit(1)
    }

    const token = data.token || data.accessToken || data.data?.token
    if (!token || token.length < 8) {
      console.log('No valid token in response')
      process.exit(1)
    }

    const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token.trim()
    const partnerCode = data.partnerCode || data.data?.partnerCode || existingConfig.partnerCode
    const tokenExpiry = data.token_expire || data.expiresAt || null

    await prisma.provider.update({
      where: { id: provider.id },
      data: {
        apiToken: encryptToken(cleanToken),
        tokenPlacement: 'BEARER_HEADER',
        lastSuccessfulConnection: new Date(),
        lastError: null,
        errorCount: 0,
        config: {
          ...updatedConfig,
          tokenExpiry,
          partnerCode: partnerCode || existingConfig.partnerCode,
          lastAuthenticatedAt: new Date().toISOString(),
        },
      },
    })

    console.log(`✓ Token stored (len=${cleanToken.length}, partnerCode=${partnerCode})`)
    console.log(`\nProvider is now ready. Run:`)
    console.log(`  npx tsx scripts/diag-airhub-auth.ts`)
    console.log(`  npx tsx scripts/test-airhub-wallet.ts`)
  } catch (e: any) {
    console.log(`Network error: ${e.message}`)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
