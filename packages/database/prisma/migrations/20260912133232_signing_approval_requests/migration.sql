-- CreateEnum
CREATE TYPE "SigningRequestStatus" AS ENUM ('PENDING_APPROVAL', 'SIGNED', 'REJECTED');

-- CreateTable
CREATE TABLE "signing_approval_requests" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "SigningRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvals" JSONB NOT NULL DEFAULT '[]',
    "rejected_by" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signing_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signing_approval_requests_merchant_id_network_status_idx" ON "signing_approval_requests"("merchant_id", "network", "status");

-- CreateIndex
CREATE INDEX "signing_approval_requests_status_idx" ON "signing_approval_requests"("status");
