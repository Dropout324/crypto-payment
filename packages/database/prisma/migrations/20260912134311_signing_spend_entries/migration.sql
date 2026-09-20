-- CreateTable
CREATE TABLE "signing_spend_entries" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signing_spend_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signing_spend_entries_merchant_id_network_occurred_at_idx" ON "signing_spend_entries"("merchant_id", "network", "occurred_at");
