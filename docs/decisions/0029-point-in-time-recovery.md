# ADR 0029 - Point-in-time recovery: continuous WAL archiving, daily base backups, Postgres-only Redis recovery, drill scoped to the primary database

Status: Accepted
Date: 2026-09-12

## Context

Phase 14 (`README.md#roadmap`) picks up where ADR 0022
left off. That baseline delivered a working `pg_dump`/`pg_restore`
mechanism, a nightly in-cluster CronJob, and a restore drill - proven for
real (a 112,929-byte dump, restored and field-verified against the live
database) but explicitly not point-in-time recovery: a full day of writes
sits at risk between nightly dumps, there is no measured RPO/RTO, no DR
runbook, and no Redis-loss or full-recovery drill. This ADR closes those
gaps: continuous WAL archiving, daily physical base backups, a PITR restore
mechanism, a Redis recovery drill, and a real, executed recovery test with
measured RPO/RTO. `docs/operations/disaster-recovery-runbook.md` is the
operator-facing companion to this ADR's decisions.

Note on ADR numbering: this ADR was drafted as 0028, but by the time it was
ready to finalize, 0027 (`0027-bitcoin-adapter.md`, Phase 13) and then 0028
(`0028-cicd-gates-and-release-process.md`, Phase 15) had both already been
taken by concurrent, unrelated in-progress work landing in parallel in this
same repository. Renumbered to 0029 - not a renumbering of anything else,
just picking the next free slot as it kept moving.

## Decisions

### `archive_command` to a dedicated PVC, not filesystem/volume snapshots or a WAL-shipping replica

`infrastructure/kubernetes/postgres.yaml` now sets `archive_mode=on`,
`wal_level=replica`, `max_wal_senders=5` and
`archive_command=test ! -f /wal-archive/%f && cp %p /wal-archive/%f` on the
postgres container, archiving into a new `wal-archive` PVC mounted
separately from `postgres-data`. The `test ! -f && cp` form is the standard
idempotent pattern: Postgres retries `archive_command` on any nonzero exit,
and without the existence check a retried invocation could overwrite an
already-archived segment with a truncated one from an interrupted `cp`. A
streaming physical replica (a second Postgres instance permanently
replaying WAL) was rejected for this baseline - it buys faster failover but
needs a second full-size Postgres workload running continuously, which is
disproportionate to a Tier-1, zero-cash-need phase; archive-based PITR
answers "can we recover to near the point of failure" without that
standing cost. `wal-archive` is deliberately a **separate PVC** from
`postgres-data`, not a subdirectory of it: the entire value of a WAL
archive is that it survives loss of the primary data volume, so sharing a
PVC (and therefore a failure domain) with `postgres-data` would defeat the
purpose.

`archive_timeout=60` forces a WAL segment switch at least every 60 seconds
even when idle, so RPO is bounded by a fixed number rather than by "how
long since write traffic happened to fill a 16MB segment" - see the
executed drill's result (README, roadmap Phase 14 section) for the RPO this
actually produced.

A `fix-wal-archive-perms` initContainer `chown -R postgres:postgres
/wal-archive` before the main container starts, the same problem
`docker-entrypoint.sh` already solves for `$PGDATA` itself but does not
know about this extra mount: a freshly, dynamically-provisioned PVC is
root-owned by default, and `archive_command` runs as the unprivileged
`postgres` user the official image drops to.

### A `pg_hba.conf` replication rule, added via `/docker-entrypoint-initdb.d`, not assumed from superuser

Found running the actual drill, not by inspection: `pg_basebackup` failed
with `no pg_hba.conf entry for replication connection...` even though
`gateway` is a superuser. The official Postgres image's default
`pg_hba.conf` allows normal client connections from any host (the `host
all all all` rule `POSTGRES_HOST_AUTH_METHOD` drives) but the `all`
database keyword does **not** match a replication connection - superuser
privilege is unrelated to this; it is purely a `pg_hba.conf` authorization
gap. Fixed with a `postgres-initdb` ConfigMap mounted at
`/docker-entrypoint-initdb.d/pg-hba-replication.sh`, the official image's
own hook for one-time, first-boot customization - it appends `host
replication ${POSTGRES_USER} all scram-sha-256` to `pg_hba.conf`
immediately after `initdb` creates it, and (correctly) never runs again on
a restart or on a PITR-restored `PGDATA` staged from a base backup that
already has the rule baked in. Verified for real after the fix: a fresh
cluster's `pg_hba.conf` had the rule with no manual intervention, and
`pg_basebackup` against it connected and streamed successfully where it
had failed before.

### `pg_basebackup`, daily, `--wal-method=none`, stored alongside the existing `pg_dump` backups

`scripts/backup/pg-basebackup.sh` (mirroring `pg-backup.sh`'s two auth
modes) and `infrastructure/kubernetes/backup/basebackup-cronjob.yaml` (daily
at 03:30 UTC, thirty minutes after the existing `pg_dump` CronJob) produce a
physical base backup via `pg_basebackup -Ft -z --wal-method=none`.
`--wal-method=none` is deliberate: continuous archiving already captures
WAL for the backup window, so streaming a redundant copy into the base
backup itself would just double-store it. Base backups do not need to run
as often as the RPO target, because continuous WAL archiving covers the gap
between them - this is precisely what distinguishes PITR from ADR 0022's
`pg_dump`-only baseline, where the gap between backups (up to a day) was
also the RPO.

No new replication role was added: `POSTGRES_USER` (`gateway`) is created
as a superuser by the official Postgres image and already carries the
replication privilege `pg_basebackup` needs.

Base backups are written to a `basebackups/` subdirectory of the existing
`postgres-backups` PVC rather than a new PVC - one durable backup store for
both the logical (`pg_dump`) and physical (`pg_basebackup`) mechanisms,
simpler to reason about and to eventually point at real offsite storage as
a single migration rather than two.

### Retention: base backups 7 days, WAL 8 days

Matches the existing `pg_dump` CronJob's 7-day retention for base backups,
and WAL is kept one day longer (8 days) than the oldest base backup still
retained - the invariant this maintains is that WAL needed to reach any
still-retained base backup's start is never pruned out from under it.
Both retention sweeps run inside `basebackup-cronjob.yaml`, immediately
after each day's base backup lands, using the same `find -mtime +N -delete`
pattern ADR 0022's `pg_dump` CronJob already established, rather than a
third CronJob.

### PITR restore: a staging Job writes `recovery.signal` + `restore_command`, Postgres itself replays and promotes

`scripts/backup/pg-restore-pitr.sh` is the operator-run mechanism script
(bash, works against any local base-backup directory and WAL-archive
directory reachable on the same filesystem) - it extracts a base backup
into a target `PGDATA`, writes `recovery.signal` and a `restore_command`
pointing at the WAL archive, and optionally a `recovery_target_time`
(omit it, or pass `latest`, to replay every WAL segment the archive still
has and let Postgres promote automatically once `restore_command` starts
failing to find the next one - the standard "recover to the end of the
archive" behavior, not special-cased here).
`infrastructure/kubernetes/backup/pitr-restore-job.template.yaml` +
`scripts/kubernetes/pitr-restore-drill.sh` run the equivalent staging logic
as an inline POSIX `sh -c` Kubernetes Job instead of calling the `.sh` file
directly - the same split ADR 0022 already established for
`pg-backup.sh`/`pg-restore.sh` vs. `cronjob.yaml`, for the same reason
(`postgres:17-alpine` has no bash). Both are kept in sync by review.

The staging Job never starts Postgres itself; it only populates PGDATA.
Scaling the `postgres` Deployment back up is what actually triggers
recovery - `pg_isready` (already the readiness probe) only starts
succeeding once WAL replay finishes and Postgres promotes, since an
archive-recovering server (no `standby.signal`) accepts no connections
during replay. That made the existing readiness probe usable, unmodified,
as the exact signal that marks the end of RTO. The `postgres` container's
`startupProbe` budget was widened (60s -> 180s, `failureThreshold: 60`,
`periodSeconds: 3`) so a PITR replay with a non-trivial amount of WAL does
not get killed mid-recovery by a threshold sized only for plain `initdb`.

### The drill destroys `postgres-data`, not the whole cluster/node

The roadmap's exit criteria ask for a recovery test "against a
destroyed-and-recreated environment." The literal reading - `kind delete
cluster` plus a full rebuild - was evaluated and rejected for this drill:
`kind`'s PV storage (`rancher.io/local-path`) is node-local, so deleting
the cluster destroys the node container and everything backed by it,
**including** `postgres-backups` and `wal-archive`. In production those
live in genuinely separate offsite/cloud storage precisely so they survive
loss of the primary environment (the disclosed production-dependent gap
below) - destroying them alongside `postgres-data` in a drill would not be
a stronger test, it would just prove the trivial and uninteresting fact
that deleting your backups too makes recovery impossible.

The drill actually executed instead destroys what a real disaster actually
threatens: `kubectl delete pvc postgres-data` (after scaling `postgres` to
zero replicas) - a real loss of the live database and its filesystem -
while `postgres-backups` and `wal-archive` are left standing, exactly
mirroring how a managed Postgres instance and its backup store are
separated in production. This is the sanctioned fallback named in the
Phase 14 brief for exactly this situation ("a partial-but-real test... is
an acceptable fallback"), not a downgrade applied silently.

A second, practical reason reinforced this choice on the day the drill ran:
this machine was running other concurrent work at the time (a second
`docker compose` stack and `act` CI containers from unrelated,
simultaneously in-progress Phase 13 work in this same repository) that made
even a *second* freshly created `kind` cluster fail its control-plane
bootstrap repeatedly under host resource pressure - independent evidence
that a full node-level teardown-and-rebuild adds fragility without adding
recovery-mechanism coverage beyond what the PVC-level destruction already
proves.

### Redis: still no backup, reaffirmed by an actual destructive drill this time

ADR 0022 already treated Redis as rebuildable queue/cache state, not backed
up, because `chain_cursors` (Postgres, carrying the scanner's
`lastProcessedBlock` and lease) and `webhook_deliveries` (Postgres,
insert-per-attempt, `IN_FLIGHT` rows picked up by the next worker poll) are
what actually make the system resume correctly - nothing Redis holds is the
only copy of anything financial. Phase 14's job was to stop asserting this
and prove it: `scripts/kubernetes/redis-recovery-drill.sh` deletes the
Redis Deployment **and its PVC** (a real AOF loss, not a `FLUSHALL` that
leaves the persistence file intact), recreates Redis empty, and confirms
`api`/`worker`/`monitor` all return to Ready using only Postgres-held
state - see the runbook and the roadmap's Phase 14 result for the drill's
actual output.

## Consequences

* `infrastructure/kubernetes/postgres.yaml` gained a `wal-archive` PVC, an
  init container, five new `-c` flags, a `wal-archive` volume mount, and a
  widened `startupProbe` budget - every existing Phase 10/11 flag and probe
  is unchanged.
* `infrastructure/kubernetes/backup/basebackup-cronjob.yaml` and
  `pitr-restore-job.template.yaml` are new; `cronjob.yaml` and
  `restore-job.template.yaml` (ADR 0022, logical `pg_dump`/`pg_restore`)
  are unchanged and remain the answer to "restore a specific point-in-time
  dump for inspection," which PITR does not replace - the two mechanisms
  serve different recovery scenarios and both stay.
* Real evidence for every claim above - base backup size, WAL bytes
  archived, measured RPO/RTO, ledger reconciliation and duplicate-credit
  verification results from the executed drill - is recorded in
  `README.md`'s Phase 14 row and `README.md#roadmap`'s
  Phase 14 Result paragraph, not duplicated here.
* **Not covered by this phase, explicitly disclosed:** offsite/cross-region
  backup storage (WAL archive, base backups and `pg_dump`s alike still live
  on local cluster PVCs - the same gap ADR 0022 already named, now applying
  to two mechanisms instead of one) and region/cloud failover specifics.
  Both are the roadmap's stated Phase 14 production-dependent gap, not
  silently dropped.
* The drill's destructive event is scoped to `postgres-data` (plus,
  separately, all of Redis's state) rather than the whole `kind`
  cluster/node - see the Decisions section above for why, and disclosed
  explicitly rather than described as a full environment teardown.
* **A real mistake made and corrected mid-drill, disclosed rather than
  quietly redone:** the first base backup attempt ran `pg_basebackup`
  directly inside the `postgres` pod via `kubectl exec`, writing to
  `/backups` - a path that pod never mounts (only `basebackup-cronjob.yaml`
  and its manually-triggered equivalent, `kubectl create job
  --from=cronjob/postgres-basebackup`, mount `postgres-backups`). That
  backup existed only on the pod's ephemeral container filesystem and was
  lost the moment the disaster step deleted that pod - discovered only when
  the PITR restore Job legitimately found no base backup to restore from.
  The drill was re-run correctly (base backup taken via the real CronJob
  mechanism, landing on the durable `postgres-backups` PVC) before
  destroying anything a second time; the shipped mechanism was never
  broken, only this one manual test invocation was.
