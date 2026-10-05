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
    <header className="z-20 border-b border-border bg-card/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          {breadcrumbs && breadcrumbs.length > 0 && (
            <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link href="/" className="rounded text-muted-foreground transition-colors hover:text-primary">
                ←
              </Link>
              {breadcrumbs.map((crumb, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-border">/</span>}
                  {crumb.href ? (
                    <Link href={crumb.href} className="transition-colors hover:text-primary">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">{crumb.label}</span>
                  )}
                </span>
              ))}
            </div>
          )}
          <h1 className="truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">{title}</h1>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {session?.user && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right sm:block">
                <p className="max-w-[180px] truncate text-sm font-medium text-foreground">{session.user.name}</p>
                <p className="max-w-[180px] truncate text-xs text-muted-foreground">{session.user.businessName || 'Admin'}</p>
              </div>
              <Link
                href={session.user.role === 'INTERNAL_ADMIN' ? '/admin/account' : '/business/account'}
                aria-label="Account settings"
                className="shrink-0"
              >
                <div className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-primary text-white transition-colors hover:bg-primary/90">
                  <span className="text-sm font-medium">
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
