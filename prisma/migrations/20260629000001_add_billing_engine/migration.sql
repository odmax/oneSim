-- Create BillingRecord table
CREATE TABLE IF NOT EXISTS "billing_records" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "order_id" TEXT,
    "esim_id" TEXT,
    "invoice_id" TEXT,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "cost" DECIMAL(65,30),
    "margin_amount" DECIMAL(65,30),
    "margin_percent" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "provider_id" TEXT,
    "sales_agent_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_records_pkey" PRIMARY KEY ("id")
);

-- Create InvoiceLineItem table
CREATE TABLE IF NOT EXISTS "invoice_line_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(65,30) NOT NULL,
    "total_price" DECIMAL(65,30) NOT NULL,
    "tax_rate" DECIMAL(65,30) DEFAULT 0,
    "tax_amount" DECIMAL(65,30) DEFAULT 0,
    "type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- Add new columns to invoices table
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "subtotal" DECIMAL(65,30);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tax_total" DECIMAL(65,30) DEFAULT 0;

-- Add foreign keys
DO $$ BEGIN
    ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "esim_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_esim_id_fkey" FOREIGN KEY ("esim_id") REFERENCES "esims"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_sales_agent_id_fkey" FOREIGN KEY ("sales_agent_id") REFERENCES "internal_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS "billing_records_business_id_created_at_idx" ON "billing_records"("business_id", "created_at");
CREATE INDEX IF NOT EXISTS "billing_records_provider_id_created_at_idx" ON "billing_records"("provider_id", "created_at");
CREATE INDEX IF NOT EXISTS "billing_records_sales_agent_id_created_at_idx" ON "billing_records"("sales_agent_id", "created_at");
CREATE INDEX IF NOT EXISTS "invoice_line_items_invoice_id_idx" ON "invoice_line_items"("invoice_id");
