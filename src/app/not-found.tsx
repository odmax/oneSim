import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4">
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm max-w-md">
        <p className="text-4xl">🔍</p>
        <h2 className="mt-4 text-xl font-bold text-gray-900">Page not found</h2>
        <p className="mt-2 text-sm text-gray-500">The page you are looking for does not exist or has moved.</p>
        <Link href="/login" className="mt-6 inline-block rounded-lg bg-emerald-600 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-700">
          Go Home
        </Link>
      </div>
    </div>
  )
}
