import Link from 'next/link'
import Image from 'next/image'
import { setPassword } from '@/lib/actions/auth-setup'

export default function SetPasswordPage({ searchParams }: { searchParams?: { token?: string; error?: string } }) {
  const token = searchParams?.token

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white px-4">
        <div className="w-full max-w-md mx-4">
          <div className="rounded-xl border-0 shadow-lg bg-[#1a1a2e] p-8 text-center">
            <p className="text-gray-300">Invalid or missing token.</p>
            <Link href="/login" className="mt-4 inline-block text-sm font-medium text-emerald-400 hover:text-emerald-300">Back to login</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="w-full max-w-md mx-4">
        <div className="rounded-xl border-0 shadow-lg bg-[#1a1a2e] p-8">
          <div className="flex justify-center mb-6">
            <Image
              src="/brand/onesim-logo-white.svg"
              alt="OneSim Logo"
              width={160}
              height={54}
              className="object-contain"
              priority
            />
          </div>

          <p className="text-center text-sm text-gray-300 mb-6">Set your password</p>

          {searchParams?.error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 mb-4">{decodeURIComponent(searchParams.error)}</div>
          )}

          <form action={setPassword} className="space-y-4">
            <input type="hidden" name="token" value={token} />
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-white">New Password</label>
              <input id="password" name="password" type="password" required minLength={8}
                className="mt-1 block w-full rounded-lg border border-gray-600 bg-[#16213e] px-4 py-2.5 text-sm text-white placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                placeholder="Min 8 characters" />
            </div>
            <div>
              <label htmlFor="confirm" className="block text-sm font-medium text-white">Confirm Password</label>
              <input id="confirm" name="confirm" type="password" required minLength={8}
                className="mt-1 block w-full rounded-lg border border-gray-600 bg-[#16213e] px-4 py-2.5 text-sm text-white placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500" />
            </div>
            <button type="submit"
              className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm transition-colors">
              Set Password
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-400">
            <Link href="/login" className="font-medium text-emerald-400 hover:text-emerald-300">Back to login</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
