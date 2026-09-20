# ADR 0022 - Backup baseline: `pg_dump` custom-format, on demand and nightly in-cluster, not point-in-time recovery

Status: Accepted
Date: 2026-09-11

## Context

Phase 10's boundary (`README.md#roadmap`) is explicit:
this pass delivers "a mechanism that actually runs and can be restored" -
Phase 14 owns point-in-time recovery, measured RPO/RTO, a DR runbook and an
executed recovery test. Before this pass there was no backup mechanism of
any kind: no script, no schedule, no restore procedure, nothing to point a
"can this be recovered" question at.

## Decisions

### `pg_dump -Fc` (custom format), not plain SQL or a filesystem/volume snapshot

Custom format supports `pg_restore`'s selective/parallel restore and is
self-describing (`pg_restore --list` reads its table of contents without
touching the target database at all) - which is what
`scripts/backup/pg-backup.sh` uses immediately after writing a dump to
fail loudly on a truncated or corrupt file rather than silently accepting a
"backup" nobody could actually restore (the same failure shape Phase 9.5
already produced once, with Docker images instead of database dumps - ADR
0021). A filesystem-level snapshot (`pg_basebackup`, a volume snapshot) was
rejected for this baseline: it captures more (WAL, in-place upgrade
compatibility) but requires infrastructure this baseline does not have yet
(a WAL archive target, snapshot-capable storage) and would be redundant work
once Phase 14 builds continuous WAL archiving properly - a logical dump
answers "does backup-then-restore actually work" without deciding Phase
14's storage architecture for it.

### One script pair, called from two places

`scripts/backup/pg-backup.sh` / `scripts/backup/pg-restore.sh` are the
single implementation - runnable by hand against any reachable Postgres
(local dev, a cloud instance, the in-cluster one via `kubectl port-forward`),
and the same `pg_dump`/`pg_restore` invocations are what
`infrastructure/kubernetes/backup/cronjob.yaml` runs unattended nightly
in-cluster (it does not shell out to the `.sh` files themselves, since the
CronJob's `postgres:17-alpine` image has no bash - but the commands inside
are the same ones, kept in sync by review rather than duplicated logic
diverging silently). A restore drill inside the cluster
(`infrastructure/kubernetes/backup/restore-job.template.yaml`, driven by
`scripts/kubernetes/restore-drill.sh`) never touches the live `gateway`
database - it restores into a separate, explicitly-named target database
every time, so a drill can never accidentally overwrite production data.

### Nightly schedule, 7-day retention, no offsite copy

`03:00 UTC` daily, kept for 7 days on the same `postgres-backups` PVC the
cluster's own storage class provisions - acceptable for a baseline whose job
is proving the mechanism works, not for production RPO (a full day of data
at risk between backups) or durability (a single PVC is not offsite storage;
losing the cluster's storage loses the backups too). Both are named
explicitly as Phase 14 gaps, not silently deferred.

## Consequences

* A real backup-then-restore run is the evidence this ADR's decisions were
  correct, not this document's prose - see the Phase 10 section of
  `README.md` and `README.md#roadmap`'s Phase 10 row for
  the actual run's result (dump size, restore outcome, row-count
  verification), recorded there rather than duplicated here so the evidence
  lives next to the honest-labels claim it supports.
* Not covered by this baseline, explicitly left to Phase 14: point-in-time
  recovery (continuous WAL archiving), measured RPO/RTO, Redis recovery
  assumptions (Redis here is treated as ephemeral queue/cache state, not
  backed up - `WEBHOOK_DISABLE_AFTER_CONSECUTIVE_FAILURES` and the
  `webhook_deliveries`/`chain_cursors` tables in Postgres are what actually
  make the system resume correctly after a Redis loss, not a Redis backup),
  a written DR runbook, and offsite/cross-region backup storage.
* The restore drill's one sanity check (`SELECT count(*) FROM merchants`) is
  a smoke check that the restored database is queryable and not empty - it
  is not the full reconciliation/ledger-balance verification Phase 14's
  exit criteria require after a real recovery test.
