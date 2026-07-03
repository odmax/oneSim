CREATE TABLE IF NOT EXISTS "catalog_change_sets" (
    "id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "description" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_changed" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    CONSTRAINT "catalog_change_sets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "catalog_change_items" (
    "id" TEXT NOT NULL,
    "change_set_id" TEXT NOT NULL,
    "provider_package_id" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "catalog_change_items_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "catalog_change_sets" ADD CONSTRAINT "catalog_change_sets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "catalog_change_items" ADD CONSTRAINT "catalog_change_items_change_set_id_fkey" FOREIGN KEY ("change_set_id") REFERENCES "catalog_change_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "catalog_change_items" ADD CONSTRAINT "catalog_change_items_provider_package_id_fkey" FOREIGN KEY ("provider_package_id") REFERENCES "provider_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
