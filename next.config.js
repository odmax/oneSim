/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Enables src/instrumentation.ts — starts the in-process low-latency job
  // worker (purchase dispatch ~1s pickup instead of cron-interval pickup).
  experimental: {
    instrumentationHook: true,
  },
  images: {
    domains: ['onesim.africa'],
  },
}

module.exports = nextConfig
