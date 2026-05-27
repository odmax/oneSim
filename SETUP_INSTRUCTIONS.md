# OneSim Database Setup Instructions

## Step 1: Update .env file

Edit the `.env` file and replace `password` with your actual PostgreSQL password:

```env
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/onesim_africa?schema=public"
```

## Step 2: Create the database

Open PowerShell or Command Prompt and run:

```powershell
# Navigate to PostgreSQL bin directory (adjust path based on your version)
cd "C:\Program Files\PostgreSQL\18\bin"

# Create the database (you'll be prompted for password)
.\psql.exe -U postgres -c "CREATE DATABASE onesim_africa;"
```

Or using pgAdmin:
1. Open pgAdmin
2. Connect to your PostgreSQL server
3. Right-click on "Databases" → "Create" → "Database"
4. Name: `onesim_africa`
5. Click "Save"

## Step 3: Run Prisma migration

Once the database is created and `.env` is updated:

```bash
npx prisma migrate dev --name init
```

## Step 4: Seed the database

```bash
npx ts-node prisma/seed.ts
```

## Step 5: Start the development server

```bash
npm run dev
```

## Step 6: Access the application

- **Admin Portal**: http://localhost:3000/admin/dashboard
  - Email: `admin@onesim.africa`
  - Password: `admin123`

- **Business Portal**: http://localhost:3000/business/dashboard
  - Email: `business@company.com`
  - Password: `business123`

## Troubleshooting

### If you get "database does not exist" error:
- Make sure you created the `onesim_africa` database
- Verify the database name in your `.env` file

### If you get "password authentication failed":
- Check that the password in `.env` matches your PostgreSQL postgres user password
- Try using `trust` authentication by editing `pg_hba.conf` (not recommended for production)

### To check if database was created:
```powershell
cd "C:\Program Files\PostgreSQL\18\bin"
.\psql.exe -U postgres -c "\l"
```
Look for `onesim_africa` in the list.

## Quick Test

After setup, test the connection:

```bash
npx prisma db pull
```

If successful, you're ready to go!
