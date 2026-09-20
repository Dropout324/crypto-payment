-- ============================================================================
-- Allow transfer_index = -1 as the reserved sentinel for a native-coin
-- transfer (ETH/BNB/POL value moved directly by the transaction itself).
--
-- EVM `logIndex` values are always >= 0 and are unique per BLOCK (not per
-- transaction) in every major client's JSON-RPC implementation, so a native
-- transfer - which has no log at all - cannot reuse a real log index without
-- risking a collision. -1 is outside the domain of any real log index and
-- there is at most one native-coin transfer per transaction, so it cannot
-- collide with itself either.
-- ============================================================================

ALTER TABLE "token_transfers"
  DROP CONSTRAINT "token_transfers_index_non_negative";

ALTER TABLE "token_transfers"
  ADD CONSTRAINT "token_transfers_index_valid" CHECK ("transfer_index" >= -1);
