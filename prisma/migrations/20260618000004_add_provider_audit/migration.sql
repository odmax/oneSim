CREATE TABLE IF NOT EXISTS "provider_audits" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL UNIQUE,
  "certificationStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
  "passCount" INTEGER NOT NULL DEFAULT 0,
  "failCount" INTEGER NOT NULL DEFAULT 0,
  "totalChecks" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_audits_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "provider_audit_checks" (
  "id" TEXT NOT NULL,
  "auditId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "checkKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "isCritical" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "checkedAt" TIMESTAMP(3),
  "checkedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_audit_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_audit_checks_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "provider_audits"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "provider_audit_notes" (
  "id" TEXT NOT NULL,
  "auditId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "authorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_audit_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_audit_notes_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "provider_audits"("id") ON DELETE CASCADE,
  CONSTRAINT "provider_audit_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "provider_audit_checks_auditId_idx" ON "provider_audit_checks"("auditId");
CREATE INDEX IF NOT EXISTS "provider_audit_notes_auditId_idx" ON "provider_audit_notes"("auditId");
