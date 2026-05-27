import Link from 'next/link'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

interface HeaderProps {
  title: string;
  breadcrumbs?: Array<{ label: string; href?: string }>
}

export default async function Header({ title, breadcrumbs }: HeaderProps) {
  const session = await getServerSession(authOptions)
  
  return (
    <header className="border-b border-gray-100 bg-white px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          {breadcrumbs && breadcrumbs.length > 0 && (
            <div className="mb-2 flex items-center gap-2 text-sm text-gray-500">
              <Link href="/" className="hover:text-cyan-600 transition-colors">
                ←
              </Link>
              {breadcrumbs.map((crumb, i) => (
                <span key={i}>
                  {i > 0 && <span className="mx-2 text-gray-300">/</span>}
                  {crumb.href ? (
                    <Link href={crumb.href} className="hover:text-cyan-600 transition-colors">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-gray-900 font-medium">{crumb.label}</span>
                  )}
                </span>
              ))}
            </div>
          )}
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        </div>
        
        <div className="flex items-center gap-4">
          {session?.user && (
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-sm font-medium text-gray-900">{session.user.name}</p>
                <p className="text-xs text-gray-500">{session.user.businessName || 'Admin'}</p>
              </div>
              <Link href={session.user.role === 'INTERNAL_ADMIN' ? '/admin/account' : '/business/account'}>
                <div className="h-8 w-8 rounded-full bg-cyan-500 flex items-center justify-center cursor-pointer hover:bg-cyan-600 transition-colors">
                  <span className="text-white text-sm font-medium">
                    {session.user.name?.charAt(0).toUpperCase()}
                  </span>
                </div>
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
