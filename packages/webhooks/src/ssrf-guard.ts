import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for merchant-supplied webhook URLs (`WEBHOOK_BLOCK_PRIVATE_NETWORKS`).
 *
 * A `WebhookEndpoint.url` is attacker-controlled input from the gateway's own
 * point of view - a merchant (or someone who compromised a merchant account)
 * could point it at `169.254.169.254` (cloud metadata), a database on the
 * private network, or `localhost`. This module refuses to deliver to anything
 * that is not a public, routable address.
 *
 * KNOWN LIMITATION: this resolves the hostname and checks the result, then
 * lets `fetch` resolve it again to actually connect - a classic
 * check-then-connect TOCTOU gap (DNS rebinding: the record changes between
 * the two lookups). Closing it fully requires pinning the resolved address
 * for the connection itself (a custom `dns.lookup`/dispatcher hook), which is
 * worth doing before this ever handles untrusted production traffic; the
 * check here still stops the overwhelming majority of real SSRF attempts
 * (a URL that is privately-addressed from the start) at a fraction of the
 * complexity.
 */

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true; // malformed -> treat as unsafe
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local (fc00::/7)
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not a recognisable IP literal -> refuse rather than guess
}

export type ResolveHostname = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface AssertPublicUrlOptions {
  /** Injectable for tests; defaults to a real DNS lookup. */
  resolve?: ResolveHostname;
}

const BLOCKED_HOSTNAMES = new Set(['localhost']);

/**
 * Throws `WebhookUrlError` unless `rawUrl` is an http(s) URL whose host
 * resolves only to public addresses. Returns the parsed URL on success.
 */
export async function assertPublicWebhookUrl(rawUrl: string, options: AssertPublicUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookUrlError(`not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookUrlError(`unsupported protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new WebhookUrlError(`refusing to deliver to ${hostname}`);
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new WebhookUrlError(`refusing to deliver to private address ${hostname}`);
    return url;
  }

  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true }));
  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolve(hostname);
  } catch {
    throw new WebhookUrlError(`could not resolve ${hostname}`);
  }

  if (records.length === 0) throw new WebhookUrlError(`could not resolve ${hostname}`);
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new WebhookUrlError(`${hostname} resolves to a private address`);
  }

  return url;
}
