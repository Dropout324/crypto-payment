-- ============================================================================
-- FINANCIAL INTEGRITY GUARDS
--
-- Application code can be wrong. These constraints make the dangerous mistakes
-- impossible at the storage layer, so a bug in a worker cannot rewrite history
-- or leave the ledger unbalanced.
--
-- Enforced here:
--   1. Ledger entries, ledger transactions, payment events and audit logs are
--      APPEND-ONLY (engineering rule #9).
--   2. Every ledger transaction balances per asset (SPEC section 20).
--   3. Amounts are non-negative where negativity is meaningless.
--   4. An invoice's priced terms are immutable after creation (SPEC section 27).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Append-only tables
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gateway_deny_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Record a compensating row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION gateway_deny_mutation();

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION gateway_deny_mutation();

CREATE TRIGGER payment_events_append_only
  BEFORE UPDATE OR DELETE ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION gateway_deny_mutation();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION gateway_deny_mutation();

-- A webhook event's payload is what was signed; redelivery must send the same
-- bytes. The row may never change once written.
CREATE TRIGGER webhook_events_append_only
  BEFORE UPDATE OR DELETE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION gateway_deny_mutation();

-- ---------------------------------------------------------------------------
-- 2. Double-entry balance enforcement
--
-- Deferred to COMMIT so a transaction can insert its debit and credit legs in
-- any order, but can never commit with them unbalanced.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gateway_assert_ledger_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  unbalanced RECORD;
  entry_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO entry_count
  FROM "ledger_entries"
  WHERE "ledger_transaction_id" = NEW."ledger_transaction_id";

  -- A single-legged posting is never valid double-entry bookkeeping.
  IF entry_count < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % entries; a posting needs at least one debit and one credit',
      NEW."ledger_transaction_id", entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  FOR unbalanced IN
    SELECT
      "asset_symbol",
      SUM(CASE WHEN "direction" = 'DEBIT'  THEN "amount" ELSE 0 END) AS debits,
      SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount" ELSE 0 END) AS credits
    FROM "ledger_entries"
    WHERE "ledger_transaction_id" = NEW."ledger_transaction_id"
    GROUP BY "asset_symbol"
    HAVING SUM(CASE WHEN "direction" = 'DEBIT'  THEN "amount" ELSE 0 END)
         <> SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount" ELSE 0 END)
  LOOP
    RAISE EXCEPTION
      'ledger transaction % is unbalanced for %: debits=% credits=%',
      NEW."ledger_transaction_id", unbalanced."asset_symbol",
      unbalanced.debits, unbalanced.credits
      USING ERRCODE = 'check_violation';
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gateway_assert_ledger_balanced();

-- An entry must belong to the account's asset; mixing assets inside one
-- account would make its balance meaningless.
CREATE OR REPLACE FUNCTION gateway_assert_entry_asset_matches_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  account_asset TEXT;
  account_decimals INTEGER;
BEGIN
  SELECT "asset_symbol", "asset_decimals"
    INTO account_asset, account_decimals
  FROM "ledger_accounts"
  WHERE "id" = NEW."account_id";

  IF account_asset IS DISTINCT FROM NEW."asset_symbol"
     OR account_decimals IS DISTINCT FROM NEW."asset_decimals" THEN
    RAISE EXCEPTION
      'entry asset %(%) does not match account % which holds %(%)',
      NEW."asset_symbol", NEW."asset_decimals",
      NEW."account_id", account_asset, account_decimals
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_asset_matches_account
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION gateway_assert_entry_asset_matches_account();

-- ---------------------------------------------------------------------------
-- 3. Value constraints
-- ---------------------------------------------------------------------------

-- Entry amounts are magnitudes; the direction column carries the sign.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_crypto_amount_positive" CHECK ("crypto_amount" > 0),
  ADD CONSTRAINT "invoices_requested_amount_positive" CHECK ("requested_amount" > 0),
  ADD CONSTRAINT "invoices_received_amount_non_negative" CHECK ("received_amount" >= 0),
  ADD CONSTRAINT "invoices_confirmed_amount_non_negative" CHECK ("confirmed_amount" >= 0),
  ADD CONSTRAINT "invoices_confirmed_not_above_received"
    CHECK ("confirmed_amount" <= "received_amount"),
  ADD CONSTRAINT "invoices_confirmations_non_negative" CHECK ("confirmation_count" >= 0),
  ADD CONSTRAINT "invoices_required_confirmations_positive"
    CHECK ("required_confirmations" > 0),
  ADD CONSTRAINT "invoices_expiry_after_creation" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "invoices_tolerances_sane"
    CHECK ("underpayment_tolerance_bps" >= 0 AND "underpayment_tolerance_bps" <= 10000
       AND "overpayment_tolerance_bps"  >= 0 AND "overpayment_tolerance_bps"  <= 10000);

-- A chain never reports a negative transfer.
ALTER TABLE "token_transfers"
  ADD CONSTRAINT "token_transfers_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "token_transfers_index_non_negative" CHECK ("transfer_index" >= 0),
  ADD CONSTRAINT "token_transfers_confirmations_non_negative" CHECK ("confirmations" >= 0);

ALTER TABLE "blockchain_transactions"
  ADD CONSTRAINT "blockchain_transactions_confirmations_non_negative"
    CHECK ("confirmations" >= 0),
  ADD CONSTRAINT "blockchain_transactions_fee_non_negative"
    CHECK ("fee_amount" IS NULL OR "fee_amount" >= 0);

ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_amounts_non_negative"
    CHECK ("gross_amount" >= 0 AND "fee_amount" >= 0 AND "network_fee" >= 0),
  ADD CONSTRAINT "settlements_net_is_gross_minus_costs"
    CHECK ("net_amount" = "gross_amount" - "fee_amount" - "network_fee"),
  ADD CONSTRAINT "settlements_net_non_negative" CHECK ("net_amount" >= 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_fee_bps_sane" CHECK ("fee_bps" >= 0 AND "fee_bps" <= 10000),
  ADD CONSTRAINT "merchants_expiry_sane"
    CHECK ("invoice_expiry_seconds" >= 60 AND "invoice_expiry_seconds" <= 604800),
  ADD CONSTRAINT "merchants_tolerances_sane"
    CHECK ("underpayment_tolerance_bps" >= 0 AND "underpayment_tolerance_bps" <= 10000
       AND "overpayment_tolerance_bps"  >= 0 AND "overpayment_tolerance_bps"  <= 10000);

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_attempt_positive" CHECK ("attempt" >= 1);

ALTER TABLE "payment_events"
  ADD CONSTRAINT "payment_events_sequence_positive" CHECK ("sequence" >= 1);

-- ---------------------------------------------------------------------------
-- 4. Invoice terms are immutable once priced
--
-- SPEC section 27: "Invoice exchange rate becomes immutable after creation."
-- The same applies to what the customer was told to send.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gateway_assert_invoice_terms_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."merchant_id"        IS DISTINCT FROM OLD."merchant_id"
     OR NEW."order_id"        IS DISTINCT FROM OLD."order_id"
     OR NEW."requested_amount" IS DISTINCT FROM OLD."requested_amount"
     OR NEW."requested_currency" IS DISTINCT FROM OLD."requested_currency"
     OR NEW."crypto_amount"   IS DISTINCT FROM OLD."crypto_amount"
     OR NEW."payment_asset"   IS DISTINCT FROM OLD."payment_asset"
     OR NEW."payment_decimals" IS DISTINCT FROM OLD."payment_decimals"
     OR NEW."network"         IS DISTINCT FROM OLD."network"
     OR NEW."token_contract"  IS DISTINCT FROM OLD."token_contract"
     OR NEW."created_at"      IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION
      'invoice % terms are immutable after creation', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The rate may be filled in once (CREATED -> PENDING), never rewritten.
  IF OLD."exchange_rate" IS NOT NULL
     AND NEW."exchange_rate" IS DISTINCT FROM OLD."exchange_rate" THEN
    RAISE EXCEPTION
      'invoice % exchange rate is frozen at %', OLD."id", OLD."exchange_rate"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_terms_immutable
  BEFORE UPDATE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION gateway_assert_invoice_terms_immutable();

-- ---------------------------------------------------------------------------
-- 5. Indexes the ORM does not express
-- ---------------------------------------------------------------------------

-- The blockchain monitor's hottest query: resolve a destination address to one
-- of ours, ignoring retired and blocked entries.
CREATE INDEX "payment_addresses_active_lookup"
  ON "payment_addresses" ("network", "address_normalized")
  WHERE "status" IN ('AVAILABLE', 'ASSIGNED');

-- The expiry sweeper only ever scans invoices that can still expire.
CREATE INDEX "invoices_expiry_sweep"
  ON "invoices" ("expires_at")
  WHERE "status" IN ('CREATED', 'PENDING', 'DETECTED', 'CONFIRMING');

-- The webhook dispatcher polls only what is actually due.
CREATE INDEX "webhook_deliveries_due"
  ON "webhook_deliveries" ("next_retry_at")
  WHERE "status" IN ('PENDING', 'FAILED');

-- The confirmation engine only tracks transfers that are not final yet.
CREATE INDEX "token_transfers_awaiting_confirmation"
  ON "token_transfers" ("network", "confirmations")
  WHERE "credited_at" IS NULL;

-- Open reconciliation discrepancies must never be hard to find.
CREATE INDEX "reconciliation_discrepancies_open"
  ON "reconciliation_discrepancies" ("severity", "created_at")
  WHERE "resolved_at" IS NULL;

-- One active API key prefix per merchant name is not required, but expired
-- keys should drop out of the auth hot path.
CREATE INDEX "api_keys_active_lookup"
  ON "api_keys" ("key_prefix")
  WHERE "status" IN ('ACTIVE', 'ROTATING');
