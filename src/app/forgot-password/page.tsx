import Link from 'next/link'
import Image from 'next/image'
import { requestPasswordReset } from '@/lib/actions/auth-setup'

export default function ForgotPasswordPage({ searchParams }: { searchParams?: { error?: string; success?: string } }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="w-full max-w-md mx-4">
        <div className="rounded-xl border-0 shadow-lg bg-[#1a1a2e] p-8">
          <div className="flex justify-center mb-6">
            <Image
              src="/brand/onesim-logo-white.svg"
              alt="OneSIM Logo"
              width={160}
              height={54}
              className="object-contain"
              priority
            />
          </div>

          <p className="text-center text-sm text-gray-300 mb-6">Reset your password</p>

          {searchParams?.error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 mb-4">{decodeURIComponent(searchParams.error)}</div>
          )}
          {searchParams?.success && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700 mb-4">{decodeURIComponent(searchParams.success)}</div>
          )}

          <form action={requestPasswordReset} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-white">Email Address</label>
              <input id="email" name="email" type="email" required
                className="mt-1 block w-full rounded-lg border border-gray-600 bg-[#16213e] px-4 py-2.5 text-sm text-white placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                placeholder="you@example.com" />
            </div>
            <button type="submit"
              className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm transition-colors">
              Send Reset Link
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-400">
            Remember your password?{' '}
            <Link href="/login" className="font-medium text-emerald-400 hover:text-emerald-300">Log in</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
