-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Network" AS ENUM ('BITCOIN', 'BITCOIN_TESTNET', 'ETHEREUM', 'ETHEREUM_SEPOLIA', 'POLYGON', 'POLYGON_AMOY', 'BSC', 'BSC_TESTNET');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'SUPPORT', 'COMPLIANCE_OFFICER', 'ADMIN');

-- CreateEnum
CREATE TYPE "MerchantRole" AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletMode" AS ENUM ('CUSTODIAL', 'MERCHANT_CONTROLLED');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'ROTATING', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('CREATED', 'PENDING', 'DETECTED', 'CONFIRMING', 'PAID', 'UNDERPAID', 'OVERPAID', 'EXPIRED', 'CANCELLED', 'FAILED', 'REFUNDED', 'COMPLIANCE_REVIEW_REQUIRED', 'LATE_PAYMENT_REVIEW', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "UnderpaymentPolicy" AS ENUM ('REJECT', 'ACCEPT_PARTIAL', 'REQUEST_ADDITIONAL', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "OverpaymentPolicy" AS ENUM ('ACCEPT_FULL', 'CREDIT_DIFFERENCE', 'REFUND_DIFFERENCE', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "AddressStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'RETIRED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ChainTxStatus" AS ENUM ('MEMPOOL', 'MINED', 'CONFIRMED', 'REVERTED', 'ORPHANED', 'REPLACED', 'DROPPED');

-- CreateEnum
CREATE TYPE "TransferMatchStatus" AS ENUM ('CREDITED', 'PENDING_CONFIRMATION', 'LATE_PAYMENT_REVIEW', 'UNSUPPORTED_ASSET', 'BELOW_MINIMUM', 'UNMATCHED', 'COMPLIANCE_HOLD', 'ORPHANED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('SCHEDULED', 'PENDING_APPROVAL', 'PROCESSING', 'BROADCAST', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'COMPLIANCE_REVIEW', 'APPROVED', 'REJECTED', 'PROCESSING', 'BROADCAST', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'DELIVERED', 'FAILED', 'EXHAUSTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PASSED', 'FLAGGED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'CLEAN', 'DISCREPANCIES_FOUND', 'FAILED');

-- CreateEnum
CREATE TYPE "DiscrepancyKind" AS ENUM ('MISSING_TRANSACTION', 'DUPLICATE_TRANSACTION', 'AMOUNT_MISMATCH', 'DESTINATION_MISMATCH', 'ASSET_MISMATCH', 'LEDGER_IMBALANCE', 'SETTLEMENT_MISMATCH', 'ORPHANED_CREDIT');

-- CreateEnum
CREATE TYPE "DiscrepancySeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "platform_role" "PlatformRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfa_secret_encrypted" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_verified_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip_address" INET,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "country_code" CHAR(2),
    "website_url" TEXT,
    "support_email" TEXT,
    "settlement_currency" TEXT NOT NULL DEFAULT 'USD',
    "wallet_mode" "WalletMode" NOT NULL DEFAULT 'MERCHANT_CONTROLLED',
    "underpayment_policy" "UnderpaymentPolicy" NOT NULL DEFAULT 'MANUAL_REVIEW',
    "overpayment_policy" "OverpaymentPolicy" NOT NULL DEFAULT 'MANUAL_REVIEW',
    "underpayment_tolerance_bps" INTEGER NOT NULL DEFAULT 0,
    "overpayment_tolerance_bps" INTEGER NOT NULL DEFAULT 0,
    "invoice_expiry_seconds" INTEGER NOT NULL DEFAULT 900,
    "fee_bps" INTEGER NOT NULL DEFAULT 0,
    "confirmation_overrides" JSONB NOT NULL DEFAULT '{}',
    "kyb_status" "ComplianceStatus" NOT NULL DEFAULT 'PENDING',
    "kyb_completed_at" TIMESTAMPTZ(6),
    "risk_score" INTEGER,
    "restricted_countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_members" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "MerchantRole" NOT NULL DEFAULT 'VIEWER',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "rotated_from_id" TEXT,
    "grace_expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "last_used_ip" INET,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "event_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret_encrypted" TEXT NOT NULL,
    "secret_fingerprint" TEXT NOT NULL,
    "previous_secret_encrypted" TEXT,
    "secret_rotated_at" TIMESTAMPTZ(6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "label" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "mode" "WalletMode" NOT NULL,
    "extended_public_key" TEXT,
    "signing_key_ref" TEXT,
    "derivation_scheme" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_accounts" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "derivation_path" TEXT NOT NULL,
    "next_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_addresses" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "wallet_account_id" TEXT,
    "network" "Network" NOT NULL,
    "address" TEXT NOT NULL,
    "address_normalized" TEXT NOT NULL,
    "asset_symbol" TEXT,
    "derivation_index" INTEGER,
    "derivation_path" TEXT,
    "status" "AddressStatus" NOT NULL DEFAULT 'AVAILABLE',
    "invoice_id" TEXT,
    "assigned_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_destinations" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "asset_symbol" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "address_normalized" TEXT NOT NULL,
    "activates_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payout_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "external_reference" TEXT,
    "description" TEXT,
    "requested_currency" TEXT NOT NULL,
    "requested_decimals" INTEGER NOT NULL,
    "requested_amount" DECIMAL(78,0) NOT NULL,
    "payment_asset" TEXT NOT NULL,
    "payment_decimals" INTEGER NOT NULL,
    "network" "Network" NOT NULL,
    "token_contract" TEXT,
    "crypto_amount" DECIMAL(78,0) NOT NULL,
    "exchange_rate" DECIMAL(78,0),
    "exchange_rate_provider" TEXT,
    "exchange_rate_at" TIMESTAMPTZ(6),
    "underpayment_policy" "UnderpaymentPolicy" NOT NULL,
    "overpayment_policy" "OverpaymentPolicy" NOT NULL,
    "underpayment_tolerance_bps" INTEGER NOT NULL,
    "overpayment_tolerance_bps" INTEGER NOT NULL,
    "required_confirmations" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'CREATED',
    "received_amount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "confirmed_amount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "confirmation_count" INTEGER NOT NULL DEFAULT 0,
    "callback_url" TEXT,
    "redirect_url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "compliance_status" "ComplianceStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "detected_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "InvoiceStatus",
    "to_status" "InvoiceStatus",
    "sequence" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_transactions" (
    "id" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "block_number" BIGINT,
    "block_hash" TEXT,
    "block_time" TIMESTAMPTZ(6),
    "tx_index" INTEGER,
    "status" "ChainTxStatus" NOT NULL DEFAULT 'MEMPOOL',
    "from_address" TEXT,
    "to_address" TEXT,
    "fee_amount" DECIMAL(78,0),
    "raw_metadata" JSONB NOT NULL DEFAULT '{}',
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "replaced_by_hash" TEXT,
    "replaces_hash" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mined_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),
    "orphaned_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "blockchain_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_transfers" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "transfer_index" INTEGER NOT NULL,
    "token_contract" TEXT,
    "asset_symbol" TEXT NOT NULL,
    "asset_decimals" INTEGER NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "from_address" TEXT,
    "to_address" TEXT NOT NULL,
    "to_address_normalized" TEXT NOT NULL,
    "payment_address_id" TEXT,
    "invoice_id" TEXT,
    "match_status" "TransferMatchStatus" NOT NULL,
    "match_reason" TEXT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "credited_at" TIMESTAMPTZ(6),
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "token_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_cursors" (
    "network" "Network" NOT NULL,
    "last_processed_block" BIGINT NOT NULL,
    "last_processed_hash" TEXT,
    "chain_tip_block" BIGINT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_reorg_at" TIMESTAMPTZ(6),
    "last_reorg_depth" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chain_cursors_pkey" PRIMARY KEY ("network")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "merchant_id" TEXT,
    "asset_symbol" TEXT NOT NULL,
    "asset_decimals" INTEGER NOT NULL,
    "network" "Network",
    "cached_balance" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "cached_balance_at" TIMESTAMPTZ(6),
    "cached_through_seq" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "invoice_id" TEXT,
    "token_transfer_id" TEXT,
    "settlement_id" TEXT,
    "refund_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "reverses_id" TEXT,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "ledger_transaction_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "asset_symbol" TEXT NOT NULL,
    "asset_decimals" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "destination_id" TEXT,
    "network" "Network" NOT NULL,
    "asset_symbol" TEXT NOT NULL,
    "asset_decimals" INTEGER NOT NULL,
    "gross_amount" DECIMAL(78,0) NOT NULL,
    "fee_amount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "network_fee" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(78,0) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'SCHEDULED',
    "signing_request_id" TEXT,
    "tx_hash" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "broadcast_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "asset_symbol" TEXT NOT NULL,
    "asset_decimals" INTEGER NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "destination_address" TEXT NOT NULL,
    "destination_address_normalized" TEXT NOT NULL,
    "destination_derived_from_payer" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "compliance_status" "ComplianceStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "rejected_by" TEXT,
    "rejected_at" TIMESTAMPTZ(6),
    "signing_request_id" TEXT,
    "tx_hash" TEXT,
    "failure_reason" TEXT,
    "broadcast_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhook_event_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "http_status" INTEGER,
    "response_time_ms" INTEGER,
    "response_body" TEXT,
    "error_message" TEXT,
    "signature_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "next_retry_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "locked_at" TIMESTAMPTZ(6),
    "response_status" INTEGER,
    "response_body" JSONB,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_checks" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "token_transfer_id" TEXT,
    "check_type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ComplianceStatus" NOT NULL,
    "risk_score" INTEGER,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "network" "Network",
    "scope" TEXT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "checked_count" INTEGER NOT NULL DEFAULT 0,
    "discrepancy_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "error_message" TEXT,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_discrepancies" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "kind" "DiscrepancyKind" NOT NULL,
    "severity" "DiscrepancySeverity" NOT NULL DEFAULT 'WARNING',
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "network" "Network",
    "expected_value" TEXT,
    "actual_value" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "user_id" TEXT,
    "merchant_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "ip_address" INET,
    "user_agent" TEXT,
    "request_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"("slug");

-- CreateIndex
CREATE INDEX "merchants_status_idx" ON "merchants"("status");

-- CreateIndex
CREATE INDEX "merchant_members_user_id_idx" ON "merchant_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_members_merchant_id_user_id_key" ON "merchant_members"("merchant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_prefix_key" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "api_keys_merchant_id_status_idx" ON "api_keys"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "webhook_endpoints_merchant_id_enabled_idx" ON "webhook_endpoints"("merchant_id", "enabled");

-- CreateIndex
CREATE INDEX "wallets_merchant_id_network_idx" ON "wallets"("merchant_id", "network");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_accounts_wallet_id_derivation_path_key" ON "wallet_accounts"("wallet_id", "derivation_path");

-- CreateIndex
CREATE UNIQUE INDEX "payment_addresses_invoice_id_key" ON "payment_addresses"("invoice_id");

-- CreateIndex
CREATE INDEX "payment_addresses_merchant_id_status_idx" ON "payment_addresses"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "payment_addresses_status_network_idx" ON "payment_addresses"("status", "network");

-- CreateIndex
CREATE UNIQUE INDEX "payment_addresses_network_address_normalized_key" ON "payment_addresses"("network", "address_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "payout_destinations_merchant_id_network_address_normalized__key" ON "payout_destinations"("merchant_id", "network", "address_normalized", "asset_symbol");

-- CreateIndex
CREATE INDEX "invoices_merchant_id_status_created_at_idx" ON "invoices"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "invoices_status_expires_at_idx" ON "invoices"("status", "expires_at");

-- CreateIndex
CREATE INDEX "invoices_network_status_idx" ON "invoices"("network", "status");

-- CreateIndex
CREATE INDEX "invoices_created_at_idx" ON "invoices"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_merchant_id_order_id_key" ON "invoices"("merchant_id", "order_id");

-- CreateIndex
CREATE INDEX "payment_events_invoice_id_created_at_idx" ON "payment_events"("invoice_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_events_type_created_at_idx" ON "payment_events"("type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_invoice_id_sequence_key" ON "payment_events"("invoice_id", "sequence");

-- CreateIndex
CREATE INDEX "blockchain_transactions_network_status_idx" ON "blockchain_transactions"("network", "status");

-- CreateIndex
CREATE INDEX "blockchain_transactions_network_block_number_idx" ON "blockchain_transactions"("network", "block_number");

-- CreateIndex
CREATE INDEX "blockchain_transactions_first_seen_at_idx" ON "blockchain_transactions"("first_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_transactions_network_tx_hash_key" ON "blockchain_transactions"("network", "tx_hash");

-- CreateIndex
CREATE INDEX "token_transfers_invoice_id_idx" ON "token_transfers"("invoice_id");

-- CreateIndex
CREATE INDEX "token_transfers_payment_address_id_idx" ON "token_transfers"("payment_address_id");

-- CreateIndex
CREATE INDEX "token_transfers_match_status_detected_at_idx" ON "token_transfers"("match_status", "detected_at");

-- CreateIndex
CREATE INDEX "token_transfers_network_to_address_normalized_idx" ON "token_transfers"("network", "to_address_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "token_transfers_network_tx_hash_transfer_index_key" ON "token_transfers"("network", "tx_hash", "transfer_index");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE INDEX "ledger_accounts_merchant_id_asset_symbol_idx" ON "ledger_accounts"("merchant_id", "asset_symbol");

-- CreateIndex
CREATE INDEX "ledger_accounts_type_idx" ON "ledger_accounts"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_key" ON "ledger_transactions"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_reverses_id_key" ON "ledger_transactions"("reverses_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_invoice_id_idx" ON "ledger_transactions"("invoice_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_type_posted_at_idx" ON "ledger_transactions"("type", "posted_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_sequence_key" ON "ledger_entries"("sequence");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_sequence_idx" ON "ledger_entries"("account_id", "sequence");

-- CreateIndex
CREATE INDEX "ledger_entries_ledger_transaction_id_idx" ON "ledger_entries"("ledger_transaction_id");

-- CreateIndex
CREATE INDEX "ledger_entries_created_at_idx" ON "ledger_entries"("created_at");

-- CreateIndex
CREATE INDEX "settlements_merchant_id_status_idx" ON "settlements"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "settlements_status_created_at_idx" ON "settlements"("status", "created_at");

-- CreateIndex
CREATE INDEX "refunds_merchant_id_status_idx" ON "refunds"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "refunds_invoice_id_idx" ON "refunds"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_idempotency_key_key" ON "webhook_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_events_merchant_id_type_occurred_at_idx" ON "webhook_events"("merchant_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "webhook_events_invoice_id_idx" ON "webhook_events"("invoice_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_retry_at_idx" ON "webhook_deliveries"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhook_event_id_endpoint_id_attempt_key" ON "webhook_deliveries"("webhook_event_id", "endpoint_id", "attempt");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_merchant_id_endpoint_key_key" ON "idempotency_keys"("merchant_id", "endpoint", "key");

-- CreateIndex
CREATE INDEX "compliance_checks_subject_type_subject_id_idx" ON "compliance_checks"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "compliance_checks_status_created_at_idx" ON "compliance_checks"("status", "created_at");

-- CreateIndex
CREATE INDEX "reconciliation_runs_status_started_at_idx" ON "reconciliation_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_run_id_idx" ON "reconciliation_discrepancies"("run_id");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_kind_resolved_at_idx" ON "reconciliation_discrepancies"("kind", "resolved_at");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_severity_resolved_at_idx" ON "reconciliation_discrepancies"("severity", "resolved_at");

-- CreateIndex
CREATE INDEX "audit_logs_merchant_id_created_at_idx" ON "audit_logs"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_created_at_idx" ON "audit_logs"("actor_type", "actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_members" ADD CONSTRAINT "merchant_members_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_members" ADD CONSTRAINT "merchant_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_addresses" ADD CONSTRAINT "payment_addresses_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_addresses" ADD CONSTRAINT "payment_addresses_wallet_account_id_fkey" FOREIGN KEY ("wallet_account_id") REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_addresses" ADD CONSTRAINT "payment_addresses_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transfers" ADD CONSTRAINT "token_transfers_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "blockchain_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transfers" ADD CONSTRAINT "token_transfers_payment_address_id_fkey" FOREIGN KEY ("payment_address_id") REFERENCES "payment_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transfers" ADD CONSTRAINT "token_transfers_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_token_transfer_id_fkey" FOREIGN KEY ("token_transfer_id") REFERENCES "token_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_transaction_id_fkey" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "payout_destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_checks" ADD CONSTRAINT "compliance_checks_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_checks" ADD CONSTRAINT "compliance_checks_token_transfer_id_fkey" FOREIGN KEY ("token_transfer_id") REFERENCES "token_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

