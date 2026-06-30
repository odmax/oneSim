-- Add PENDING to InvoiceStatus enum for invoice filtering
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'PENDING';
