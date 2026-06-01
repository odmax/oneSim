-- AlterTable: add archive fields to esim_packages
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "esim_packages" ADD COLUMN IF NOT EXISTS "hiddenFromCatalog" BOOLEAN NOT NULL DEFAULT false;
