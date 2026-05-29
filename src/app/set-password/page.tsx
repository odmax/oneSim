import Link from 'next/link'
import { setPassword } from '@/lib/actions/auth-setup'

export default function SetPasswordPage({ searchParams }: { searchParams?: { token?: string; error?: string } }) {
  const token = searchParams?.token

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="text-gray-500">Invalid or missing token.</p>
          <Link href="/login" className="mt-4 inline-block text-sm font-medium text-emerald-600 hover:text-emerald-700">Back to login</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">OneSim Africa</h1>
          <p className="mt-2 text-sm text-gray-500">Set your password</p>
        </div>

        {searchParams?.error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{decodeURIComponent(searchParams.error)}</div>
        )}

        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
          <form action={setPassword} className="space-y-4">
            <input type="hidden" name="token" value={token} />
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">New Password</label>
              <input id="password" name="password" type="password" required minLength={8}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" placeholder="Min 8 characters" />
            </div>
            <div>
              <label htmlFor="confirm" className="block text-sm font-medium text-gray-700">Confirm Password</label>
              <input id="confirm" name="confirm" type="password" required minLength={8}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-emerald-500 focus:outline-none" />
            </div>
            <button type="submit" className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 shadow-sm">
              Set Password
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500">
          <Link href="/login" className="font-medium text-emerald-600 hover:text-emerald-700">Back to login</Link>
        </p>
      </div>
    </div>
  )
}
