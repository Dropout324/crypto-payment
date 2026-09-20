# ADR 0003 - Local development database

Status: Accepted
Date: 2026-09-08

## Context

The schema depends on PostgreSQL features that are not portable: `plpgsql`
triggers for the append-only and ledger-balance guarantees, deferrable
constraint triggers, partial indexes, `NUMERIC(78,0)`, and `timestamptz`.
Verifying a migration therefore requires a real PostgreSQL server.

Docker was not available on the initial development machine. PGlite (PostgreSQL
compiled to WASM) was evaluated as a substitute and rejected: its socket server
closes the client connection on any SQL error, which makes it unusable for a
test suite whose entire purpose is to assert that invalid writes are rejected.

## Decision

`docker-compose.yml` is the supported development environment and the one
production mirrors.

For machines without Docker, `scripts/dev-postgres.ps1` runs a real PostgreSQL
server from a conda environment against a gitignored `.pgdata` directory. It is
a convenience, not a second supported target: it runs the same server version
family and the same migrations.

## Consequences

* Integration tests need a live database. They are not skipped when one is
  absent - they fail, because a green suite that silently tested nothing is
  worse than a red one.
* The migration history is generated with `prisma migrate diff` and applied with
  `prisma migrate deploy`, which needs no shadow database. `prisma migrate dev`
  requires one and is used only when a developer has the full Docker stack.
