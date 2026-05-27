import { PrismaClient } from '@prisma/client'
import { encryptToken, decryptToken } from '../src/lib/encryption'

const prisma = new PrismaClient()

async function main() {
  console.log('Scanning for unencrypted provider apiToken values...\n')

  const providers = await prisma.provider.findMany({
    where: { apiToken: { not: null } },
    select: { id: true, name: true, code: true, apiToken: true },
  })

  let encrypted = 0
  let alreadyEncrypted = 0
  let failed = 0

  for (const p of providers) {
    if (!p.apiToken) continue

    const parts = p.apiToken.split(':')
    if (parts.length === 3) {
      try {
        const decrypted = decryptToken(p.apiToken)
        if (decrypted !== null) {
          console.log(`  ✓ ${p.code} (${p.name}) — already encrypted`)
          alreadyEncrypted++
          continue
        }
      } catch {
        // Not encrypted, fall through
      }
    }

    // Plaintext token — encrypt it
    const encryptedToken = encryptToken(p.apiToken)
    if (!encryptedToken) {
      console.log(`  ✗ ${p.code} (${p.name}) — FAILED to encrypt`)
      failed++
      continue
    }

    // Verify round-trip before saving
    const roundTrip = decryptToken(encryptedToken)
    if (roundTrip !== p.apiToken) {
      console.log(`  ✗ ${p.code} (${p.name}) — round-trip verification FAILED`)
      failed++
      continue
    }

    await prisma.provider.update({
      where: { id: p.id },
      data: { apiToken: encryptedToken },
    })

    console.log(`  ✓ ${p.code} (${p.name}) — encrypted`)
    encrypted++
  }

  console.log(`\nDone. ${encrypted} encrypted, ${alreadyEncrypted} already encrypted, ${failed} failed.`)
}

main()
  .catch((e) => {
    console.error('Fatal:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
