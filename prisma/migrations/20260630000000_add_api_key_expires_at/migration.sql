-- Add expiresAt to business_api_keys
ALTER TABLE "business_api_keys" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
