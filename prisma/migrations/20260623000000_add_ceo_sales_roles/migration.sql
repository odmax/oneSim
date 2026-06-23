-- Add CEO and SALES_TEAM to InternalAdminRole enum
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'CEO';
ALTER TYPE "InternalAdminRole" ADD VALUE IF NOT EXISTS 'SALES_TEAM';

-- Add assignedSalesUserId to businesses table
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "assignedSalesUserId" TEXT;

-- Add foreign key for assignedSalesUserId
DO $$ BEGIN
  ALTER TABLE "businesses" ADD CONSTRAINT "businesses_assignedSalesUserId_fkey"
    FOREIGN KEY ("assignedSalesUserId") REFERENCES "internal_admins"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
