# Disaster recovery runbook

Phase 14 (C4), ADR 0029. This runbook covers recovery **mechanics** - what
to run, in what order, and what it proves - for an operator who did not
build this system. It is not the incident-response **process** (severity
levels, escalation, merchant communication): that is Phase 16
(`README.md#roadmap`), not yet built. Do not infer that
process exists because this runbook exists.

Measured evidence (backup sizes, RPO/RTO, verification results) from the
drill this runbook was written and executed against lives in `README.md`'s
Phase 14 row and `README.md#roadmap`'s Phase 14 Result
paragraph - this document states the numbers plainly where relevant, but
the narrative evidence is there, not duplicated here.

## Recovery targets

- **RPO (Recovery Point Objective):** bounded by `archive_timeout=60`
  (`infrastructure/kubernetes/postgres.yaml`) - at most 60 seconds of
  committed writes are at risk if the primary is lost at an arbitrary
  moment, because Postgres forces a WAL segment switch (and therefore an
  archive) at least that often even when idle. An operator can drive this
  to effectively zero before a planned event by running
  `SELECT pg_switch_wal();` immediately beforehand, as the drill did.
- **RTO (Recovery Time Objective):** the measured wall-clock time from
  "disaster declared" to Postgres verified Ready (accepting connections
  again, promoted) in the executed drill - see the Phase 14 Result
  paragraph for the actual number. It scales with how much WAL must be
  replayed, not with base-backup size, since replay dominates restore
  time once the base backup is on disk.

## Scenario 1: PostgreSQL data loss or corruption (primary database is gone or untrustworthy)

Two mechanisms exist; pick the one that fits:

**A. Point-in-time recovery (ADR 0029) - use this for anything the nightly
`pg_dump` might have missed, or to recover to a specific moment (e.g. "just
before the bad migration ran").**

1. Confirm the backup store is intact: `postgres-backups` and
   `wal-archive` PVCs must still exist and be mountable - if they are also
   gone, PITR cannot help; fall back to the last `pg_dump` (Scenario 1B)
   or, if that is also gone, there is no recovery path (this is why those
   two volumes being offsite in a real deployment matters - see ADR 0029's
   disclosed gap).
2. Decide a target: `latest` (replay every WAL segment the archive has) or
   a specific UTC timestamp (`recovery_target_time`), e.g. to recover to
   just before a known-bad event.
3. Run `scripts/kubernetes/pitr-restore-drill.sh [basebackup-name|latest]
   [target-time|latest]`. This scales `postgres` to zero, deletes and
   recreates `postgres-data` (this step **is** the destructive part - do
   not run it against a database you have not already decided to replace),
   stages the restore via a one-off Job, then scales `postgres` back to one
   replica. Postgres itself replays WAL and promotes; the script's own
   `kubectl rollout status` wait is what marks RTO's end.
4. Restart the other three services so their database connections are
   fresh, not reused against the old backend:
   `kubectl -n gateway rollout restart deployment/api deployment/worker deployment/monitor`.
5. Verify (Scenario "Post-recovery verification" below) before declaring
   the incident closed.

Manual/operator-driven equivalent, if you need to restore onto a host
outside the cluster (e.g. to inspect data without touching production):
`scripts/backup/pg-restore-pitr.sh <basebackup-dir> <wal-archive-dir>
<pgdata-target> [target-time|latest]` stages a `PGDATA` directory from a
base backup plus a reachable copy of the WAL archive (e.g. after
`kubectl cp`-ing both out of their PVCs) - start Postgres against that
directory yourself afterward.

**B. Logical restore from the nightly `pg_dump` (ADR 0022) - use this to
inspect a specific day's data, or when PITR is unavailable.**

1. `scripts/kubernetes/restore-drill.sh <dump-filename> [target-db-name]`
   restores into a **separate, newly created database** (default
   `gateway_restore_drill`) - it never overwrites the live `gateway`
   database. Use this to inspect or extract data.
2. To actually cut the application over to a restored logical dump (only
   if PITR is unavailable and the live database must be replaced):
   restore into a database named `gateway` on a fresh `postgres-data`
   volume using `scripts/backup/pg-restore.sh`, then point `DATABASE_URL`
   at it and restart the four services. This loses everything written
   since that dump was taken (up to 24 hours, per ADR 0022's nightly
   schedule) - PITR (1A) is almost always the better choice when the WAL
   archive is available.

## Scenario 2: full environment loss (the whole cluster/node is gone)

The stateless half (namespace, ConfigMap, Secret, `api`/`worker`/`monitor`/`web`
Deployments, Ingress, migration Job) rebuilds from the manifests and images
exactly as Phase 10/11 already proved: `scripts/kubernetes/build-and-load.sh`
then `scripts/kubernetes/deploy.sh` against a fresh cluster, following
`docs/operations/deployment-guide.md`.

The stateful half depends entirely on where `postgres-backups` and
`wal-archive` actually live:

- **If they are on durable, offsite storage independent of the lost
  cluster** (the production configuration this baseline's local PVCs stand
  in for - see ADR 0029's disclosed gap): recreate the cluster and its
  storage classes so they can be re-attached or restored into, then follow
  Scenario 1A against the fresh cluster.
- **If they were only ever local PVCs on the lost cluster/node** (as they
  are in this baseline's default configuration): they are gone with
  everything else. This is precisely why offsite backup storage is a
  disclosed production-dependent gap, not an oversight - a new owner
  deploying for real must point `postgres-backups`/`wal-archive` at
  something that survives losing the cluster (an object-storage-backed
  volume, a managed snapshot target, etc.) before this scenario has a real
  answer.

The executed Phase 14 drill deliberately did not destroy the whole
`kind` node/cluster for this reason - see ADR 0029's "The drill destroys
`postgres-data`, not the whole cluster/node" decision for the full
reasoning, and the Phase 14 Result paragraph for what was destroyed and
restored instead.

## Scenario 3: Redis loss

Nothing to restore - by design (ADR 0022, reaffirmed by ADR 0029's actual
drill). Redis holds cache and queue/lease-adjacent state, never the only
copy of anything financial:

- The blockchain scanner's resume point is `chain_cursors`
  (`last_processed_block`, `lease_owner`, `lease_expires_at`) - **Postgres**,
  not Redis.
- A webhook delivery a crashed worker left `IN_FLIGHT` is a row in
  `webhook_deliveries` (**Postgres**) - the next worker poll tick picks it
  up from there, not from a Redis queue of record.

Recovery is simply: let Redis come back empty (or run
`scripts/kubernetes/redis-recovery-drill.sh` to exercise this for real -
it deletes the Redis Deployment **and its PVC**, a genuine AOF loss, then
verifies `api`/`worker`/`monitor` all return to `Ready` using only
Postgres-held state). No manual data recovery step exists for Redis because
none is needed.

## Scenario 4: RPC provider outage

`EvmRpcClient` (`packages/blockchain`) already fails over to
`*_RPC_FALLBACK_URL` automatically (ADR 0025 made this configuration
mandatory for every mainnet network in production). If both the primary and
fallback are down:

1. The blockchain monitor's scan loop simply stops making progress on that
   network - `chain_cursors.chain_tip_block` stops advancing, which is what
   the existing lag alerting (Phase 16, where implemented) is meant to
   catch. No data is lost or corrupted by an RPC outage alone: the cursor
   holds its last confirmed position and resumes exactly from there once
   an RPC endpoint is reachable again.
2. Operator action: update `*_RPC_URL`/`*_RPC_FALLBACK_URL` in the Secret
   to a working provider and restart `monitor`
   (`kubectl -n gateway rollout restart deployment/monitor`). No database
   change is needed - the scanner catches up from its existing cursor.
3. A real multi-network mainnet RPC failover test (a provider actually
   going down mid-scan, not just config plumbing) is Phase 24 (mainnet
   validation)'s job, not this phase's - disclosed, not silently assumed.

## Scenario 5: mid-processing service crash (api/worker/monitor)

This is the normal case the architecture is already built for, not a
special recovery procedure:

- Kubernetes restarts a crashed pod automatically (`restartPolicy` on every
  Deployment); `startupProbe`/`readinessProbe`/`livenessProbe` (Phase 10/11)
  gate traffic until it is actually healthy again.
- `worker`: a webhook delivery mid-send when the pod dies is left
  `IN_FLIGHT` in `webhook_deliveries` and picked up by the next poll tick
  on restart (or on another replica, if ever run at more than one - see
  `monitor.yaml`'s own comment on why multi-replica safety is unverified,
  Phase 28).
- `monitor`: `chain_cursors`' lease (`lease_owner`/`lease_expires_at`) lets
  a stalled worker be taken over without re-scanning from genesis or
  skipping blocks - a crash simply stops updating the lease, and it expires
  for the next holder to pick up.
- `api`: stateless; a crashed pod's in-flight HTTP requests fail to the
  caller (retried at the client/SDK level, same as any HTTP service) and a
  restarted pod serves the next request normally.

No drill-specific script exists for this scenario because it requires no
DR-specific mechanism - it is exercised implicitly by every other drill's
service restarts in this runbook, and directly by Phase 10's own SIGTERM
proof (`README.md`'s graceful-shutdown section).

## Duplicate-event handling

`token_transfers`' `UNIQUE(network, tx_hash, transfer_index)` constraint
(`packages/database/prisma/schema.prisma`) is the actual mechanism that
prevents a double credit, whether the duplicate arises from a chain reorg,
a restarted scan re-observing an already-processed block, or an operator
error during recovery. `scripts/kubernetes/dr-verify.cjs` re-runs the real
ledger reconciliation (`@gateway/ledger`'s `runLedgerReconciliation`, SPEC
section 21) plus a raw `GROUP BY (network, tx_hash, transfer_index) HAVING
count(*) > 1` query as part of every drill's post-recovery verification -
see the Phase 14 Result paragraph for its output on the executed drill.

## Post-recovery verification (run after any Scenario 1 or 2 recovery)

1. All four services `Ready`:
   `kubectl -n gateway get pods -l 'app in (api,worker,monitor,web)'`.
2. A real request round-trips through the restored database - the same
   proof Phase 10 used: `POST /v1/auth/login` against the seeded merchant
   owner returns `200`.
3. `DATABASE_URL=<restored> node scripts/kubernetes/dr-verify.cjs` -
   prints merchant/ledger-account/invoice counts, `chain_cursors` state,
   the duplicate-transfer check, and runs `runLedgerReconciliation`; a
   `VERIFY: PASS` line and reconciliation `status: "CLEAN"` are what
   "ledger balances reconcile" means operationally for this system.
4. If recovering via PITR from a target time before "now", confirm the
   expected data is present (an invoice/row you know should exist at that
   target time) and that anything created after the target time is
   correctly absent - this is the difference between "PITR replayed WAL"
   and "PITR silently did nothing and served the bare base backup."

## Where the mechanism scripts live

| Script | Purpose |
|---|---|
| `scripts/backup/pg-backup.sh` / `pg-restore.sh` | Logical `pg_dump`/`pg_restore` (ADR 0022) |
| `scripts/backup/pg-basebackup.sh` | Physical base backup for PITR (ADR 0029) |
| `scripts/backup/pg-restore-pitr.sh` | Stages a PITR restore from a base backup + WAL archive, operator-run |
| `scripts/kubernetes/restore-drill.sh` | In-cluster logical restore into a separate DB (ADR 0022) |
| `scripts/kubernetes/pitr-restore-drill.sh` | In-cluster PITR: destroys `postgres-data`, restores, measures RTO |
| `scripts/kubernetes/redis-recovery-drill.sh` | Destroys Redis state, verifies self-heal from Postgres alone |
| `scripts/kubernetes/dr-verify.cjs` | Post-recovery reconciliation + duplicate-credit verification |
| `scripts/kubernetes/dr-test.sh` | Full drill orchestration (seed, pre/post-backup activity, backup, disaster, restore, verify) |
| `infrastructure/kubernetes/backup/cronjob.yaml` | Nightly `pg_dump` CronJob (ADR 0022) |
| `infrastructure/kubernetes/backup/basebackup-cronjob.yaml` | Daily `pg_basebackup` + base-backup/WAL retention (ADR 0029) |
