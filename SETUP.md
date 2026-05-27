# OneSim Africa - Setup Guide

## Prerequisites

1. **PostgreSQL Database**
   - Install PostgreSQL or use a cloud provider (Neon, Supabase, etc.)
   - Create a database named `onesim_africa`
   - Update `.env` file with your database URL

2. **Node.js**
   - Version 18 or higher

## Environment Configuration

Update `.env` file with your actual values:

```env
# Database - Replace with your actual PostgreSQL connection string
DATABASE_URL="postgresql://username:password@localhost:5432/onesim_africa?schema=public"

# NextAuth - Generate a secure secret
NEXTAUTH_SECRET="generate-a-32-character-secret-minimum"
NEXTAUTH_URL="http://localhost:3000"

# App
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

Generate NEXTAUTH_SECRET:
```bash
openssl rand -base64 32
```

## Installation Steps

1. **Install dependencies** (already done):
   ```bash
   npm install
   ```

2. **Generate Prisma Client** (already done):
   ```bash
   npx prisma generate
   ```

3. **Run database migration**:
   ```bash
   npx prisma migrate dev --name init
   ```

4. **Seed the database**:
   ```bash
   npx ts-node prisma/seed.ts
   ```

5. **Start the development server**:
   ```bash
   npm run dev
   ```

## Default Login Credentials

After seeding:

### Admin Portal
- URL: http://localhost:3000/admin/dashboard
- Email: `admin@onesim.africa`
- Password: `admin123`

### Business Portal
- URL: http://localhost:3000/business/dashboard
- Email: `business@company.com`
- Password: `business123`

## Database Setup Options

### Option 1: Local PostgreSQL
```bash
# Ubuntu/Debian
sudo apt-get install postgresql
sudo -u postgres createdb onesim_africa
```

### Option 2: Using Docker
```bash
docker run -d \
  --name onesim-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=onesim_africa \
  -p 5432:5432 \
  postgres:15
```

### Option 3: Cloud Database (Recommended for production)
- **Neon**: https://neon.tech (Serverless PostgreSQL)
- **Supabase**: https://supabase.com
- **Railway**: https://railway.app

## Project Structure

```
OneSim Africa/
├── prisma/
│   ├── schema.prisma          # Database schema
│   └── seed.ts                # Seed data script
├── src/
│   ├── app/
│   │   ├── api/               # API routes
│   │   │   ├── auth/          # NextAuth endpoint
│   │   │   ├── esim/          # eSIM API endpoints
│   │   │   └── businesses/    # Business API endpoints
│   │   ├── business/          # Business portal pages
│   │   │   ├── dashboard/
│   │   │   ├── profile/
│   │   │   ├── buy-esim/
│   │   │   ├── esims/
│   │   │   ├── orders/
│   │   │   ├── users/
│   │   │   ├── wallet/
│   │   │   └── usage/
│   │   ├── admin/             # Admin portal pages
│   │   │   ├── dashboard/
│   │   │   ├── businesses/
│   │   │   ├── packages/
│   │   │   ├── orders/
│   │   │   ├── esims/
│   │   │   ├── analytics/
│   │   │   ├── settings/
│   │   │   └── audit-logs/
│   │   └── login/             # Login page
│   ├── lib/
│   │   ├── auth/              # Auth configuration
│   │   ├── services/          # Mock API services
│   │   │   ├── esim.service.ts
│   │   │   └── payment.service.ts
│   │   ├── actions/           # Server actions (CRUD)
│   │   ├── validations/       # Zod schemas
│   │   ├── prisma.ts          # Prisma client
│   │   └── utils.ts           # Utility functions
│   └── components/
│       ├── ui/                # Reusable UI components
│       ├── layout/            # Layout components
│       ├── business/          # Business-specific components
│       └── admin/             # Admin-specific components
├── .env                       # Environment variables
├── package.json
├── tsconfig.json
├── next.config.js
├── tailwind.config.js
└── README.md
```

## Future API Integration

When ready to connect to the real OneSim API, update these files:

1. **eSIM Service** (`src/lib/services/esim.service.ts`):
   - Replace mock functions with actual API calls to `https://api.onesim.africa/...`

2. **Payment Service** (`src/lib/services/payment.service.ts`):
   - Integrate with payment gateway (Stripe, Paystack, Flutterwave)

3. **Environment variables**:
   ```env
   ONESIM_API_KEY="your-api-key"
   ONESIM_API_URL="https://api.onesim.africa/v1"
   PAYMENT_GATEWAY_KEY="your-payment-key"
   ```

## Troubleshooting

### Database connection failed
- Verify PostgreSQL is running
- Check DATABASE_URL in `.env`
- Ensure database `onesim_africa` exists

### Prisma errors
```bash
npx prisma validate    # Validate schema
npx prisma format     # Format schema
npx prisma db pull    # Pull schema from database
```

### NextAuth errors
- Verify NEXTAUTH_SECRET is set
- Ensure NEXTAUTH_URL matches your domain
- Check that the database tables are created

## Next Steps

1. Set up PostgreSQL database
2. Update `.env` with correct DATABASE_URL
3. Run `npx prisma migrate dev --name init`
4. Run `npx ts-node prisma/seed.ts`
5. Run `npm run dev`
6. Visit http://localhost:3000
7. Login with provided credentials
8. Start building your features!
