# ADR 0005 - CoinGecko's free tier is the default exchange-rate provider

Status: Accepted
Date: 2026-09-08

## Context

SPEC section 27 requires a pluggable `ExchangeRateProvider` with a fallback,
timeout, and staleness detection, but no specific provider was mandated. No
paid market-data subscription was available while building Phase 2.

## Decision

`ExchangeRateService` (`packages/exchange-rate`) composes providers in a
configurable priority order (`EXCHANGE_RATE_PROVIDERS` env var, default
`coingecko,binance`) and never depends on any one of them. CoinGecko's public
`/simple/price` endpoint is the default primary provider (no API key required
at low volume); Binance's public ticker endpoint is the default fallback.

The service, not the providers, owns caching and staleness:

* every returned rate is checked against `EXCHANGE_RATE_MAX_AGE_SECONDS`
  using the service's own (injectable) clock - never a provider's or the
  system's real clock directly, which is what makes the staleness path
  deterministically testable;
* concurrent requests for the same pair are coalesced into one upstream call;
* a rate cached but now stale is refetched, never served past its age limit,
  even if the cache TTL would otherwise still consider it fresh.

## Consequences

* At meaningful production volume, CoinGecko's free tier will rate-limit.
  Before processing real merchant volume, either configure `COINGECKO_API_KEY`
  (paid tier) or add a provider such as a licensed market-data feed - both are
  additive, since new providers only need to implement `ExchangeRateProvider`.
* Every provider is tested exclusively through a fake `fetch`; no test in this
  codebase makes a real network call to price an asset, so the suite is
  deterministic and does not depend on market conditions or provider uptime.
* An invoice's rate is frozen at creation (`exchange_rate`,
  `exchange_rate_provider`, `exchange_rate_at` columns, enforced immutable by
  the ADR 0001 migration's trigger) regardless of which provider or fallback
  path produced it - the provenance travels with the invoice for audit, but
  the rate itself never moves.
