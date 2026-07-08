import Link from 'next/link'

export default function UnauthorizedPage() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-4">🔒</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h1>
        <p className="text-gray-600 mb-6">
          You do not have permission to access this page. Contact an administrator if you believe this is an error.
        </p>
        <Link
          href="/admin/dashboard"
          className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}
