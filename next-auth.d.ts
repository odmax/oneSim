import { DefaultSession } from 'next-auth'
import { UserRole, BusinessUserRole, InternalAdminRole } from '@prisma/client'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: UserRole
      businessId: string | null
      businessName: string | null
      businessRole: BusinessUserRole | null
      internalAdminRole: InternalAdminRole | null
    } & DefaultSession['user']
  }

  interface User {
    role: UserRole
    businessId?: string | null
    businessName?: string | null
    businessRole?: BusinessUserRole | null
    internalAdminRole?: InternalAdminRole | null
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string
    role: UserRole
    businessId: string | null
    businessName: string | null
    businessRole: BusinessUserRole | null
    internalAdminRole: InternalAdminRole | null
  }
}
