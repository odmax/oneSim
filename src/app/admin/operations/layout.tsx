import Link from 'next/link'

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  const links = [
    { href: '/admin/operations', label: 'Overview' },
    { href: '/admin/operations/jobs', label: 'Jobs' },
    { href: '/admin/operations/providers', label: 'Providers' },
  ]

  return (
    <div>
      <nav className="flex gap-1 px-6 pt-4 border-b bg-white">
        {links.map(l => (
          <Link key={l.href} href={l.href}
            className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent hover:border-gray-300 rounded-t">
            {l.label}
          </Link>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  )
}
