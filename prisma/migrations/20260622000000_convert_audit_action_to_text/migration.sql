-- Convert audit_logs.action from AuditAction enum to TEXT
-- The old enum only had: CREATE, UPDATE, DELETE, LOGIN, LOGOUT, APPROVE, SUSPEND
-- Current code uses 30+ distinct action strings (PROVIDER_CONNECTION_TESTED, etc.)
-- The Prisma schema now defines action as String (TEXT), not enum.

ALTER TABLE "audit_logs" ALTER COLUMN "action" DROP DEFAULT;
ALTER TABLE "audit_logs" ALTER COLUMN "action" TYPE TEXT USING "action"::text;
ALTER TABLE "audit_logs" ALTER COLUMN "action" SET NOT NULL;

-- Drop the unused enum type (safe after column conversion)
DROP TYPE IF EXISTS "AuditAction";
