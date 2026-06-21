-- ProviderHealthSnapshot
CREATE TABLE IF NOT EXISTS "provider_health_snapshots" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HEALTHY',
    "responseTimeMs" INTEGER,
    "successRate" DOUBLE PRECISION,
    "lastCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_health_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_health_snapshots_providerId_idx" ON "provider_health_snapshots"("providerId");
CREATE INDEX IF NOT EXISTS "provider_health_snapshots_status_idx" ON "provider_health_snapshots"("status");
CREATE INDEX IF NOT EXISTS "provider_health_snapshots_createdAt_idx" ON "provider_health_snapshots"("createdAt");
DO $$ BEGIN
  ALTER TABLE "provider_health_snapshots" ADD CONSTRAINT "provider_health_snapshots_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- ProviderFailoverEvent
CREATE TABLE IF NOT EXISTS "provider_failover_events" (
    "id" TEXT NOT NULL,
    "originalProviderId" TEXT,
    "fallbackProviderId" TEXT,
    "packageId" TEXT,
    "orderId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_failover_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_failover_events_originalProviderId_idx" ON "provider_failover_events"("originalProviderId");
CREATE INDEX IF NOT EXISTS "provider_failover_events_fallbackProviderId_idx" ON "provider_failover_events"("fallbackProviderId");
CREATE INDEX IF NOT EXISTS "provider_failover_events_createdAt_idx" ON "provider_failover_events"("createdAt");

-- SupportTicket
CREATE TABLE IF NOT EXISTS "support_tickets" (
    "id" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "subject" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "relatedEsimId" TEXT,
    "relatedOrderId" TEXT,
    "relatedInvoiceId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_ticketNumber_key" ON "support_tickets"("ticketNumber");
CREATE INDEX IF NOT EXISTS "support_tickets_businessId_idx" ON "support_tickets"("businessId");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets"("status");
CREATE INDEX IF NOT EXISTS "support_tickets_priority_idx" ON "support_tickets"("priority");
CREATE INDEX IF NOT EXISTS "support_tickets_assignedToId_idx" ON "support_tickets"("assignedToId");
CREATE INDEX IF NOT EXISTS "support_tickets_lastMessageAt_idx" ON "support_tickets"("lastMessageAt");
CREATE INDEX IF NOT EXISTS "support_tickets_createdAt_idx" ON "support_tickets"("createdAt");
DO $$ BEGIN
  ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- SupportMessage
CREATE TABLE IF NOT EXISTS "support_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL DEFAULT 'BUSINESS_USER',
    "message" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "support_messages_ticketId_createdAt_idx" ON "support_messages"("ticketId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;

-- SupportTypingState
CREATE TABLE IF NOT EXISTS "support_typing_states" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isTyping" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_typing_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_typing_states_ticketId_userId_key" ON "support_typing_states"("ticketId", "userId");

-- SupportTicketEvent
CREATE TABLE IF NOT EXISTS "support_ticket_events" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "actorId" TEXT,
    "eventType" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "support_ticket_events_ticketId_createdAt_idx" ON "support_ticket_events"("ticketId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
