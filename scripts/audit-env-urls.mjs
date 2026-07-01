#!/usr/bin/env node
/**
 * Environment URL Audit Script
 * Scans src/, docs/, scripts/ for hardcoded domains and risky URL patterns.
 * Usage: node scripts/audit-env-urls.mjs
 */

import { readFileSync, existsSync } from 'fs'
import { readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = new URL('..', import.meta.url).pathname
const SCAN_DIRS = ['src', 'docs', 'scripts']

const PROD_DOMAIN = 'm2m.onetelecom.cloud'
const STAGING_DOMAIN = 'staging.onetelecom.cloud'

const results = { hardcodedProd: [], hardcodedStaging: [], nextAuthUrl: [], unsafeCallback: [], appUrlDirect: [], siteUrlDirect: [] }

function scanFile(filePath) {
  const relPath = relative(ROOT, filePath)
  const content = readFileSync(filePath, 'utf-8')

  // Skip node_modules, .next, .git
  if (relPath.includes('node_modules') || relPath.includes('.next') || relPath.includes('.git')) return

  // Check for hardcoded production domain
  if (content.includes(PROD_DOMAIN)) {
    // Find lines with the domain
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (line.includes(PROD_DOMAIN)) {
        const trimmed = line.trim().substring(0, 120)
        if (!trimmed.includes('// ' + PROD_DOMAIN) && !trimmed.includes('/* ' + PROD_DOMAIN)) {
          if (!results.hardcodedProd.some(r => r.file === relPath && r.line === i + 1)) {
            results.hardcodedProd.push({ file: relPath, line: i + 1, code: trimmed })
          }
        }
      }
    })
  }

  // Check for hardcoded staging domain
  if (content.includes(STAGING_DOMAIN)) {
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (line.includes(STAGING_DOMAIN)) {
        const trimmed = line.trim().substring(0, 120)
        if (!trimmed.includes('// ' + STAGING_DOMAIN) && !trimmed.includes('/* ' + STAGING_DOMAIN)) {
          if (!results.hardcodedStaging.some(r => r.file === relPath && r.line === i + 1)) {
            results.hardcodedStaging.push({ file: relPath, line: i + 1, code: trimmed })
          }
        }
      }
    })
  }

  // Check for NEXTAUTH_URL direct usage
  if (content.includes('NEXTAUTH_URL') && (content.includes('process.env') || content.includes('process\.env'))) {
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (line.includes('NEXTAUTH_URL') && (line.includes('process.env') || line.includes('process'))) {
        results.nextAuthUrl.push({ file: relPath, line: i + 1, code: line.trim().substring(0, 120) })
      }
    })
  }

  // Check for unsafe callbackUrl handling
  if ((content.includes('callbackUrl') || content.includes('callback_url') || content.includes('callback-url'))) {
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      const lc = line.toLowerCase()
      if ((lc.includes('callbackurl') || lc.includes('callback_url') || lc.includes('callback-url'))) {
        const trimmed = line.trim().substring(0, 120)
        if (!trimmed.includes('safeCallbackUrl') && !trimmed.includes('safe_callback')) {
          results.unsafeCallback.push({ file: relPath, line: i + 1, code: trimmed })
        }
      }
    })
  }

  // Check for APP_URL direct usage (without config helper)
  if (content.includes('process.env.APP_URL') && content.includes("'") || content.includes('"APP_URL"')) {
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      if (line.includes('process.env.APP_URL') && !line.includes('getAppBaseUrl') && !line.includes('app-url')) {
        results.appUrlDirect.push({ file: relPath, line: i + 1, code: line.trim().substring(0, 120) })
      }
    })
  }
}

function walkDir(dir) {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) walkDir(fullPath)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.mjs') || entry.name.endsWith('.md') || entry.name.endsWith('.sh')) {
      scanFile(fullPath)
    }
  }
}

for (const dir of SCAN_DIRS) {
  walkDir(join(ROOT, dir))
}

// Print results
console.log('\n=== OneSim Environment URL Audit ===\n')

let total = 0

if (results.hardcodedProd.length > 0) {
  console.log(`\n⚠ Hardcoded Production URLs (${results.hardcodedProd.length}):`)
  results.hardcodedProd.forEach(r => {
    console.log(`  ${r.file}:${r.line}  ${r.code}`)
    total++
  })
}

if (results.hardcodedStaging.length > 0) {
  console.log(`\n⚠ Hardcoded Staging URLs (${results.hardcodedStaging.length}):`)
  results.hardcodedStaging.forEach(r => {
    console.log(`  ${r.file}:${r.line}  ${r.code}`)
    total++
  })
}

if (results.nextAuthUrl.length > 0) {
  console.log(`\nℹ NEXTAUTH_URL direct usage (${results.nextAuthUrl.length}):`)
  results.nextAuthUrl.forEach(r => {
    console.log(`  ${r.file}:${r.line}  ${r.code}`)
  })
}

if (results.unsafeCallback.length > 0) {
  console.log(`\n⚠ Unsafe callbackUrl handling (${results.unsafeCallback.length}):`)
  results.unsafeCallback.forEach(r => {
    console.log(`  ${r.file}:${r.line}  ${r.code}`)
    total++
  })
}

if (results.appUrlDirect.length > 0) {
  console.log(`\nℹ APP_URL direct usage (${results.appUrlDirect.length}):`)
  results.appUrlDirect.forEach(r => {
    console.log(`  ${r.file}:${r.line}  ${r.code}`)
  })
}

if (total === 0) {
  console.log('✅ No hardcoded domain issues found.')
} else {
  console.log(`\n⚠ ${total} potential issues found. Review and fix.`)
}

console.log('\nDone.\n')
