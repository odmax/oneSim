import Link from 'next/link'
import { requestPasswordReset } from '@/lib/actions/auth-setup'

export default function ForgotPasswordPage({ searchParams }: { searchParams?: { error?: string; success?: string } }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">OneSim Africa</h1>
          <p className="mt-2 text-sm text-gray-500">Reset your password</p>
        </div>

        {searchParams?.error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>
        )}
        {searchParams?.success && (
          <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700">{decodeURIComponent(searchParams.success)}</div>
        )}

        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
          <form action={requestPasswordReset} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">Email Address</label>
              <input id="email" name="email" type="email" required
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" placeholder="you@example.com" />
            </div>
            <button type="submit" className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Send Reset Link
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500">
          Remember your password? <Link href="/login" className="font-medium text-emerald-600 hover:text-emerald-700">Log in</Link>
        </p>
      </div>
    </div>
  )
}
