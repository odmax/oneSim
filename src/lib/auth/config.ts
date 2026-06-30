import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@next-auth/prisma-adapter'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import type { UserRole, InternalAdminRole } from '@prisma/client'

// Validate NEXTAUTH_SECRET at startup — never fall back to random in production/staging
const nextAuthSecret = process.env.NEXTAUTH_SECRET
if (!nextAuthSecret) {
  console.error('========================================')
  console.error('  FATAL: NEXTAUTH_SECRET is not set!')
  console.error('  Set NEXTAUTH_SECRET in .env or .env.production')
  console.error('  All sessions will be invalidated on restart.')
  console.error('  Generate with: openssl rand -base64 32')
  console.error('========================================')
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXTAUTH_SECRET is required in production')
  }
}
if (nextAuthSecret && nextAuthSecret.length < 16) {
  console.error('WARNING: NEXTAUTH_SECRET is too short (< 16 chars). Use a strong random secret.')
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  secret: nextAuthSecret || (process.env.NODE_ENV !== 'production' ? 'dev-fallback-secret-do-not-use-in-production' : undefined),
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
          include: {
            businessUsers: {
              include: { business: true },
            },
            internalAdmin: true,
          },
        })

        if (!user || !user.isActive) {
          return null
        }

        // Check if business user's business is approved
        if (user.role === 'BUSINESS_USER') {
          const businessUser = await prisma.businessUser.findFirst({
            where: { userId: user.id },
            include: { business: true }
          })
          
          if (businessUser && businessUser.business.status === 'PENDING') {
            throw new Error('pending')
          }
          
          if (businessUser && businessUser.business.status === 'SUSPENDED') {
            throw new Error('suspended')
          }
          
          if (businessUser && businessUser.business.status !== 'APPROVED') {
            return null
          }
        }

        if (!user.passwordHash) return null

        const isPasswordValid = await bcrypt.compare(
          credentials.password,
          user.passwordHash
        )

        if (!isPasswordValid) {
          return null
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          businessId: user.businessUsers[0]?.businessId || null,
          businessName: user.businessUsers[0]?.business.name || null,
          businessRole: user.businessUsers[0]?.role || null,
          internalAdminRole: user.internalAdmin?.role || null,
        }
      },
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      if (token) {
        session.user.id = token.id as string
        session.user.role = token.role as any
        session.user.businessId = token.businessId as string | null
        session.user.businessName = token.businessName as string | null
        session.user.businessRole = token.businessRole as any
        session.user.internalAdminRole = token.internalAdminRole as any
      }
      return session
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = user.role
        token.businessId = user.businessId ?? null
        token.businessName = user.businessName ?? null
        token.businessRole = user.businessRole ?? null
        token.internalAdminRole = user.internalAdminRole ?? null
      }
      return token
    },
  },
}
