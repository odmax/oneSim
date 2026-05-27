# OneSim Africa - B2B eSIM Management Platform

A production-ready B2B eSIM management platform built with Next.js 14, TypeScript, Prisma, and PostgreSQL.

## Features

### Business Portal
- Company registration/login
- Manage company profile
- Buy eSIM packages
- View purchased eSIMs with QR codes
- Check eSIM usage
- View orders and invoices
- Manage team members
- Wallet/billing balance

### Admin Portal
- Manage businesses (approve/suspend)
- Manage eSIM packages
- View all orders
- Monitor eSIMs
- Dashboard analytics
- Settings management
- Audit logs

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS, shadcn/ui
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: NextAuth.js
- **Validation**: Zod
- **Mock APIs**: Placeholder service layer for eSIM and payment integration

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL database
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   ```bash
   cp .env.example .env
   ```
   Update `.env` with your database URL and NextAuth secret.

4. Run Prisma migrations:
   ```bash
   npx prisma migrate dev --name init
   ```

5. Seed the database:
   ```bash
   npx ts-node prisma/seed.ts
   ```

6. Start the development server:
   ```bash
   npm run dev
   ```

## Default Login Credentials

### Admin Portal
- Email: `admin@onesim.africa`
- Password: `admin123`

### Business Portal
- Email: `business@company.com`
- Password: `business123`

## Project Structure

```
src/
├── app/
│   ├── api/auth/[...nextauth]  # NextAuth API route
│   ├── business/                # Business portal pages
│   │   ├── dashboard/
│   │   ├── profile/
│   │   ├── buy-esim/
│   │   ├── esims/
│   │   ├── orders/
│   │   ├── users/
│   │   ├── wallet/
│   │   └── usage/
│   ├── admin/                   # Admin portal pages
│   │   ├── dashboard/
│   │   ├── businesses/
│   │   ├── packages/
│   │   ├── orders/
│   │   ├── esims/
│   │   ├── analytics/
│   │   ├── settings/
│   │   └── audit-logs/
│   └── login/                   # Unified login page
├── lib/
│   ├── auth/                    # Auth configuration
│   ├── services/                # Mock API service layer
│   │   ├── esim.service.ts
│   │   └── payment.service.ts
│   ├── actions/                 # Server actions
│   ├── validations/             # Zod schemas
│   └── prisma.ts                # Prisma client
└── components/
    ├── ui/                      # Reusable UI components
    ├── business/                 # Business-specific components
    ├── admin/                    # Admin-specific components
    └── layout/                   # Layout components
```

## API Integration Points

The platform uses a mock service layer that can be easily replaced with real APIs:

### eSIM Service (`src/lib/services/esim.service.ts`)
- `provisionESIMs()` - Provision new eSIMs
- `getESIMStatus()` - Check eSIM status
- `getESIMUsage()` - Get usage data
- `suspendESIM()` - Suspend an eSIM
- `activateESIM()` - Activate an eSIM

### Payment Service (`src/lib/services/payment.service.ts`)
- `processPayment()` - Process order payments
- `topUpWallet()` - Add funds to wallet
- `getPaymentMethods()` - Get available payment methods

## Database Models

- **User** - System users (business users and internal admins)
- **Business** - Company accounts
- **BusinessUser** - Links users to businesses with roles
- **InternalAdmin** - Internal admin users
- **ESIMPackage** - eSIM package definitions
- **ESIMPurchase** - eSIM purchase records
- **ESIM** - Individual eSIM instances
- **UsageRecord** - eSIM data usage tracking
- **Invoice** - Billing invoices
- **WalletTransaction** - Wallet transaction history
- **AuditLog** - System audit trail
- **Setting** - Platform settings

## License

MIT
