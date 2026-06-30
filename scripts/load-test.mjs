#!/usr/bin/env node
/**
 * OneSim Load Test Script
 * Simulates concurrent API traffic against staging/production.
 * Usage: node scripts/load-test.mjs [--base-url URL] [--api-key KEY] [--concurrency N]
 */

const BASE_URL = process.argv.find(a => a.startsWith('--base-url='))?.split('=')[1] || 'http://127.0.0.1:3001'
const API_KEY = process.argv.find(a => a.startsWith('--api-key='))?.split('=')[1] || 'test-key'
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '10')

const ENDPOINTS = [
  { method: 'GET', path: '/api/health', weight: 5 },
  { method: 'GET', path: '/api/health/db', weight: 3 },
  { method: 'GET', path: '/api/health/providers', weight: 2 },
  { method: 'GET', path: '/api/v1/auth/verify', weight: 5, headers: { 'x-api-key': API_KEY } },
  { method: 'GET', path: '/api/v1/packages', weight: 8, headers: { 'x-api-key': API_KEY } },
  { method: 'GET', path: '/api/v1/orders', weight: 5, headers: { 'x-api-key': API_KEY } },
  { method: 'GET', path: '/api/v1/wallet', weight: 5, headers: { 'x-api-key': API_KEY } },
]

function weightedPick() {
  const total = ENDPOINTS.reduce((s, e) => s + e.weight, 0)
  let r = Math.random() * total
  for (const ep of ENDPOINTS) {
    r -= ep.weight
    if (r <= 0) return ep
  }
  return ENDPOINTS[0]
}

async function request(ep) {
  const url = `${BASE_URL}${ep.path}`
  const start = Date.now()
  try {
    const res = await fetch(url, {
      method: ep.method,
      headers: { 'Content-Type': 'application/json', ...(ep.headers || {}) },
      signal: AbortSignal.timeout(10000),
    })
    const duration = Date.now() - start
    const body = await res.text()
    return { path: ep.path, status: res.status, duration, success: res.status < 500, bodyLength: body.length }
  } catch (e) {
    return { path: ep.path, status: 0, duration: Date.now() - start, success: false, error: e.message }
  }
}

async function runLoadTest() {
  const totalRequests = CONCURRENCY * 10
  console.log(`\n=== OneSim Load Test ===`)
  console.log(`  Base URL: ${BASE_URL}`)
  console.log(`  Concurrency: ${CONCURRENCY}`)
  console.log(`  Total Requests: ${totalRequests}`)
  console.log(`\nRunning...\n`)

  const results = []
  const startTime = Date.now()

  // Process in batches
  for (let batch = 0; batch < totalRequests; batch += CONCURRENCY) {
    const batchSize = Math.min(CONCURRENCY, totalRequests - batch)
    const promises = []
    for (let i = 0; i < batchSize; i++) {
      promises.push(request(weightedPick()))
    }
    const batchResults = await Promise.all(promises)
    results.push(...batchResults)

    if ((batch + batchSize) % (CONCURRENCY * 2) === 0) {
      process.stdout.write('.')
    }
  }

  const totalDuration = Date.now() - startTime
  const successful = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length
  const avgDuration = results.reduce((s, r) => s + r.duration, 0) / results.length
  const sortedDurations = results.map(r => r.duration).sort((a, b) => a - b)
  const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1] || 0
  const p99 = sortedDurations[Math.ceil(sortedDurations.length * 0.99) - 1] || 0
  const throughput = Math.round((results.length / totalDuration) * 1000)

  // Per-endpoint stats
  const byPath = {}
  for (const r of results) {
    if (!byPath[r.path]) byPath[r.path] = { total: 0, success: 0, durations: [] }
    byPath[r.path].total++
    if (r.success) byPath[r.path].success++
    byPath[r.path].durations.push(r.duration)
  }

  console.log(`\n\n=== Results ===`)
  console.log(`  Total: ${results.length} requests in ${totalDuration}ms`)
  console.log(`  Successful: ${successful}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Success Rate: ${Math.round((successful / results.length) * 100)}%`)
  console.log(`  Avg Latency: ${Math.round(avgDuration)}ms`)
  console.log(`  P95 Latency: ${p95}ms`)
  console.log(`  P99 Latency: ${p99}ms`)
  console.log(`  Throughput: ${throughput} req/s`)

  console.log(`\n=== Per-Endpoint ===`)
  for (const [path, stats] of Object.entries(byPath)) {
    const avg = Math.round(stats.durations.reduce((s, d) => s + d, 0) / stats.durations.length)
    const sorted = [...stats.durations].sort((a, b) => a - b)
    const p95e = sorted[Math.ceil(sorted.length * 0.95) - 1] || 0
    const rate = Math.round((stats.success / stats.total) * 100)
    console.log(`  ${path}: ${stats.total} calls, ${rate}% success, avg ${avg}ms, P95 ${p95e}ms`)
  }

  // Warning for slow endpoints
  console.log(`\n=== Warnings ===`)
  for (const [path, stats] of Object.entries(byPath)) {
    const avg = Math.round(stats.durations.reduce((s, d) => s + d, 0) / stats.durations.length)
    if (avg > 1000) console.log(`  ⚠ ${path} — avg ${avg}ms (target: <1000ms)`)
    if (stats.success / stats.total < 0.95) console.log(`  ✗ ${path} — ${Math.round((1 - stats.success / stats.total) * 100)}% failure rate`)
  }

  console.log(`\nDone.`)
}

runLoadTest().catch(console.error)
