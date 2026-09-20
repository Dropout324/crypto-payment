import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPrismaClient } from '@gateway/database';
import { verifyWebhookSignature } from '@gateway/security';
import { createPublicClient, createWalletClient, http as viemHttp, parseEther, formatEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { seedMerchantWithLogin } from '../test/support/seed-merchant-login.js';

/**
 * Phase 19 (C9) - Enterprise demo, core flow.
 *
 * A single command that proves the full non-custodial payment lifecycle
 * against a REAL testnet, not a simulation: merchant registers a deposit
 * address, creates an invoice, a real Ethereum Sepolia transaction is sent
 * to that address from an operator-held demo wallet, the already-running
 * `blockchain-monitor`/`worker` detect it, track confirmations, credit the
 * ledger and deliver a signed webhook - which this script itself receives
 * and verifies, closing the loop. Every step uses the real HTTP API a
 * merchant would use, never direct database writes for anything the API
 * itself can do (the one deliberate exception, `seedMerchantWithLogin`, only
 * provisions the merchant account and API key - there is no signup endpoint
 * in this API's scope, matching the same precedent `loadtest/seed.ts` and
 * `apps/web`'s own E2E fixtures already established).
 *
 * Prerequisites (see demo/README.md for the full walkthrough):
 *   - `pnpm dev:infra` (Postgres + Redis)
 *   - `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:monitor` running in
 *     separate terminals, with `ETHEREUM_SEPOLIA_RPC_URL` set in `.env`
 *   - `WEBHOOK_BLOCK_PRIVATE_NETWORKS=false` in `.env` for `dev:worker`,
 *     since this script's own webhook receiver is `127.0.0.1` - the SSRF
 *     guard refuses production boots with this set, so it stays a
 *     dev-only override, not a product change
 *   - `DEMO_WALLET_PRIVATE_KEY` set in `.env`, funded with free Sepolia test
 *     ETH from a faucet (this script prints the address and a faucet link
 *     the first time it runs with no key configured)
 *
 * Two consecutive runs produce the same observable result (a full PAID
 * lifecycle with a verified webhook) because every run creates its own
 * fresh, uniquely-named merchant, deposit address and invoice - nothing is
 * shared or mutated between runs, matching how every other seeded fixture
 * in this codebase (`seedMerchant`, the E2E suite) already avoids
 * cross-run state.
 */

const API_BASE_URL = process.env.DEMO_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const WEBHOOK_PORT = Number(process.env.DEMO_WEBHOOK_PORT ?? 4100);
const DEMO_AMOUNT_USD = process.env.DEMO_AMOUNT_USD ?? '5.00';
const NETWORK = 'ethereum_sepolia';
const ASSET = 'ETH';
const CURRENCY = 'USD';
const MIN_WALLET_BALANCE_WEI = parseEther('0.01'); // covers the payment plus gas with headroom
const STATUS_POLL_INTERVAL_MS = 5_000;
const STATUS_TIMEOUT_MS = 10 * 60 * 1000; // Sepolia block time ~12s * 3 confirmations, generous margin
const WEBHOOK_TIMEOUT_MS = 2 * 60 * 1000;

function log(step: string, message: string): void {
  console.log(`[${new Date().toISOString()}] ${step}: ${message}`);
}

function randomEvmAddress(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

async function waitForApi(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/v1/health`);
    if (!response.ok) throw new Error(`GET /v1/health returned ${response.status}`);
  } catch (error) {
    throw new Error(
      `API is not reachable at ${baseUrl} - start it first (pnpm dev:api) before running the demo. Cause: ${(error as Error).message}`,
    );
  }
}

interface WebhookReceipt {
  rawBody: string;
  signatureHeader: string;
  eventType: string;
}

async function startWebhookReceiver(
  port: number,
): Promise<{ url: string; received: Promise<WebhookReceipt>; close: () => Promise<void> }> {
  let resolveReceived!: (receipt: WebhookReceipt) => void;
  const received = new Promise<WebhookReceipt>((resolve) => {
    resolveReceived = resolve;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const signatureHeader = String(req.headers['x-signature'] ?? '');
      const eventType = String(req.headers['x-webhook-event-type'] ?? 'unknown');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
      resolveReceived({ rawBody, signatureHeader, eventType });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}/demo-webhook`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function apiRequest<T>(
  method: string,
  path: string,
  apiKeyPlaintext: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKeyPlaintext}`,
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Webhook endpoint management (`/v1/merchant/me/webhook-endpoints`) is
 * dashboard-session auth (`JwtAuthGuard`, an httpOnly `gw_access` cookie),
 * not API-key auth - it is a "me" route the merchant dashboard itself
 * calls, distinct from the API-key-authenticated integration surface
 * (addresses, invoices) `apiRequest` above targets. This performs a real
 * `POST /v1/auth/login`, the same Argon2id-verified login the dashboard
 * uses, and returns the `gw_access` cookie value for subsequent requests.
 */
async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/auth/login failed: ${response.status} ${await response.text()}`);
  }
  const setCookies = response.headers.getSetCookie();
  const accessCookie = setCookies.find((c) => c.startsWith('gw_access='));
  if (!accessCookie) throw new Error('login succeeded but no gw_access cookie was set');
  return accessCookie.split(';')[0]!;
}

async function sessionRequest<T>(
  method: string,
  path: string,
  sessionCookie: string,
  merchantId: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie,
      'x-merchant-id': merchantId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

interface InvoiceStatusResponse {
  id: string;
  status: string;
  confirmation_count: number;
  required_confirmations: number;
  received_amount: string;
  crypto_amount: string;
  transaction_hash: string | null;
}

async function main(): Promise<void> {
  console.log('=== Crypto Payment Gateway - Enterprise Demo (Phase 19) ===\n');

  const sepoliaRpcUrl = process.env.ETHEREUM_SEPOLIA_RPC_URL;
  if (!sepoliaRpcUrl) {
    throw new Error('ETHEREUM_SEPOLIA_RPC_URL is not set in .env - see demo/README.md');
  }

  const publicClient = createPublicClient({ chain: sepolia, transport: viemHttp(sepoliaRpcUrl) });

  const privateKey = process.env.DEMO_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    const generated = generatePrivateKey();
    const address = privateKeyToAccount(generated).address;
    console.log(
      [
        'No DEMO_WALLET_PRIVATE_KEY configured - generated a fresh one for you.',
        '',
        '1. Add this line to your .env:',
        `   DEMO_WALLET_PRIVATE_KEY=${generated}`,
        '',
        '2. Fund this address with FREE Sepolia test ETH (no real money):',
        `   ${address}`,
        '   Faucets: https://www.alchemy.com/faucets/ethereum-sepolia',
        '            https://sepoliafaucet.com',
        '',
        '3. Re-run `pnpm demo` once the faucet transaction confirms.',
      ].join('\n'),
    );
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: sepolia, transport: viemHttp(sepoliaRpcUrl) });

  const balance = await publicClient.getBalance({ address: account.address });
  log('wallet', `demo wallet ${account.address} balance: ${formatEther(balance)} ETH (Sepolia)`);
  if (balance < MIN_WALLET_BALANCE_WEI) {
    console.log(
      [
        `Balance too low (need at least ${formatEther(MIN_WALLET_BALANCE_WEI)} ETH).`,
        `Fund ${account.address} from a Sepolia faucet, then re-run:`,
        '  https://www.alchemy.com/faucets/ethereum-sepolia',
      ].join('\n'),
    );
    process.exit(1);
  }

  await waitForApi(API_BASE_URL);
  log('api', `reachable at ${API_BASE_URL}`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const db = createPrismaClient({ databaseUrl });

  log('merchant', 'seeding a fresh demo merchant + test-mode API key...');
  const merchant = await seedMerchantWithLogin(db, { livemode: false });
  log('merchant', `merchant ${merchant.merchantId} ready`);

  const depositAddress = randomEvmAddress();
  await apiRequest('POST', '/v1/merchant/addresses', merchant.apiKeyPlaintext, {
    network: NETWORK,
    asset: ASSET,
    address: depositAddress,
    label: 'Enterprise demo deposit address',
  });
  log('merchant', `registered deposit address ${depositAddress} on ${NETWORK}`);

  const sessionCookie = await login(merchant.email, merchant.password);
  log('merchant', `logged in as ${merchant.email} (dashboard session)`);

  const receiver = await startWebhookReceiver(WEBHOOK_PORT);
  const webhookEndpoint = await sessionRequest<{ id: string; secret: string }>(
    'POST',
    '/v1/merchant/me/webhook-endpoints',
    sessionCookie,
    merchant.merchantId,
    { url: receiver.url },
  );
  log('merchant', `registered webhook endpoint ${receiver.url}`);

  const invoice = await apiRequest<{
    id: string;
    payment_address: string;
    crypto_amount: string;
    payment_uri: string | null;
  }>('POST', '/v1/payment-invoices', merchant.apiKeyPlaintext, {
    order_id: `demo-${randomUUID()}`,
    amount: DEMO_AMOUNT_USD,
    currency: CURRENCY,
    asset: ASSET,
    network: NETWORK,
  });
  log(
    'invoice',
    `created ${invoice.id} - pay ${invoice.crypto_amount} ${ASSET} to ${invoice.payment_address}`,
  );

  log('payment', `sending ${invoice.crypto_amount} ETH from the demo wallet on Sepolia...`);
  const txHash = await walletClient.sendTransaction({
    account,
    chain: sepolia,
    to: invoice.payment_address as `0x${string}`,
    value: parseEther(invoice.crypto_amount),
  });
  log('payment', `sent - https://sepolia.etherscan.io/tx/${txHash}`);

  log('detection', 'waiting for blockchain-monitor to detect the payment and the ledger to confirm it...');
  const finalStatus = await pollUntilPaid(invoice.id, merchant.apiKeyPlaintext);
  log(
    'detection',
    `status=${finalStatus.status} confirmations=${finalStatus.confirmation_count}/${finalStatus.required_confirmations} tx=${finalStatus.transaction_hash}`,
  );

  log('webhook', 'waiting for the signed webhook delivery...');
  const webhook = await Promise.race([
    receiver.received,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for webhook delivery')), WEBHOOK_TIMEOUT_MS),
    ),
  ]);
  const verification = verifyWebhookSignature(webhookEndpoint.secret, webhook.rawBody, webhook.signatureHeader);
  const verificationDetail = verification.valid
    ? 'signature_valid=true'
    : `signature_valid=false reason=${verification.reason}`;
  log('webhook', `received event_type=${webhook.eventType} ${verificationDetail}`);

  const balances = await apiRequest<Array<{ network: string; asset: string; available: string }>>(
    'GET',
    `/v1/merchant/balance?network=${NETWORK}&asset=${ASSET}`,
    merchant.apiKeyPlaintext,
  );
  log('ledger', `merchant balance for ${ASSET} on ${NETWORK}: ${JSON.stringify(balances)}`);

  await receiver.close();
  await db.$disconnect();

  console.log('\n=== Demo complete ===');
  console.log(`Invoice:     ${invoice.id} (${finalStatus.status})`);
  console.log(`Transaction: https://sepolia.etherscan.io/tx/${txHash}`);
  console.log(`Webhook:     ${webhook.eventType}, signature valid=${verification.valid}`);
}

async function pollUntilPaid(invoiceId: string, apiKeyPlaintext: string): Promise<InvoiceStatusResponse> {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let last: InvoiceStatusResponse | undefined;
  while (Date.now() < deadline) {
    last = await apiRequest<InvoiceStatusResponse>(
      'GET',
      `/v1/payment-invoices/${invoiceId}/status`,
      apiKeyPlaintext,
    );
    log(
      'detection',
      `status=${last.status} confirmations=${last.confirmation_count}/${last.required_confirmations}`,
    );
    if (last.status === 'PAID') return last;
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  throw new Error(`invoice ${invoiceId} did not reach PAID within ${STATUS_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`);
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:', error);
  process.exit(1);
});
