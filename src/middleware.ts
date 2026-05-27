import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    const token = req.nextauth.token
    const path = req.nextUrl.pathname

    // Redirect to appropriate dashboard based on role
    if (path === '/dashboard') {
      if (token?.role === 'INTERNAL_ADMIN') {
        return NextResponse.redirect(new URL('/admin', req.url))
      } else if (token?.role === 'BUSINESS_USER') {
        return NextResponse.redirect(new URL('/business', req.url))
      }
    }

    // Protect admin routes
    if (path.startsWith('/admin')) {
      if (token?.role !== 'INTERNAL_ADMIN') {
        return NextResponse.redirect(new URL('/login', req.url))
      }
    }

    // Protect business routes
    if (path.startsWith('/business')) {
      if (token?.role !== 'BUSINESS_USER') {
        return NextResponse.redirect(new URL('/login', req.url))
      }
      
      // Check if business is approved
      if (token?.role === 'BUSINESS_USER' && path !== '/business/pending') {
        // This is a simplified check - in real app, you'd verify business status
        // For now, we'll let the business layout handle the redirect
      }
    }

    return NextResponse.next()
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
)

export const config = {
  matcher: ['/dashboard', '/admin/:path*', '/business/:path*', '/admin', '/business'],
}
