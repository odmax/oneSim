-- CreateTable
CREATE TABLE "esim_package_provider_bindings" (
    "id" TEXT NOT NULL,
    "esimPackageId" TEXT NOT NULL,
    "providerPackageId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "esim_package_provider_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "esim_package_provider_bindings_esimPackageId_providerPackageId_key"
ON "esim_package_provider_bindings"("esimPackageId", "providerPackageId");

-- CreateIndex
CREATE INDEX "esim_package_provider_bindings_providerPackageId_idx"
ON "esim_package_provider_bindings"("providerPackageId");

-- CreateIndex
CREATE INDEX "esim_package_provider_bindings_esimPackageId_idx"
ON "esim_package_provider_bindings"("esimPackageId");

-- AddForeignKey
ALTER TABLE "esim_package_provider_bindings"
ADD CONSTRAINT "esim_package_provider_bindings_esimPackageId_fkey"
FOREIGN KEY ("esimPackageId")
REFERENCES "esim_packages"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esim_package_provider_bindings"
ADD CONSTRAINT "esim_package_provider_bindings_providerPackageId_fkey"
FOREIGN KEY ("providerPackageId")
REFERENCES "provider_packages"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
