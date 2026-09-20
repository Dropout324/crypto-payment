import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeBlockchainAdapter, makeTestBlock, makeTestTransaction } from '@gateway/blockchain';
import { type PrismaClient, createPrismaClient, decimalToUnits } from '@gateway/database';
import { EnvKeyProvider, encryptSecret, verifyWebhookSignature } from '@gateway/security';
import { findAsset, newId } from '@gateway/shared';
import { WebhookDispatcher } from '@gateway/webhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MonitorService } from '../src/monitor.service.js';
import { createMerchant, createPendingInvoice } from './support/fixtures.js';

/**
 * The narrowest tests in this app (`monitor.e2e.test.ts`) stop once a
 * `webhook_events` row exists - that is where `MonitorService`'s own
 * responsibility ends (SPEC/ADR 0009: detection and dispatch are separate
 * concerns, owned by `apps/blockchain-monitor` and `apps/worker`
 * respectively). This file is the one test that walks the FULL pipeline
 * those two apps only implement half of each: a simulated on-chain payment,
 * through `MonitorService` (detection, confirmation, ledger posting), through
 * `@gateway/webhooks`'s real `WebhookDispatcher`, to a real local HTTP
 * receiver standing in for the merchant's server - real Postgres and a real
 * loopback HTTP round trip throughout, no mocked transport or database.
 *
 * `blockPrivateNetworks: false` and `guardedFetch` carry the same rationale
 * as `packages/webhooks/test/dispatcher.live-http.test.ts`: the SSRF guard
 * always refuses loopback addresses (correctly, for production), so it must
 * be off to reach the local receiver, and `guardedFetch` keeps that from
 * turning into a real request to some unrelated leftover fixture elsewhere
 * in this shared dev database.
 */

let db: PrismaClient;
let monitor: MonitorService;
const keyProvider = new EnvKeyProvider();

const NETWORK = 'ETHEREUM' as const;
const USDT = findAsset(NETWORK, 'USDT')!;
const USDT_CONTRACT = USDT.contractAddress!;

let counter = 0;
function suffix(): string {
  counter += 1;
  return `${Date.now().toString(16)}-${counter}`;
}
function freshHash(label: string): string {
  return `0x${(suffix() + label).padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '1')}`;
}
function freshAddress(): string {
  return `0x${suffix().padEnd(40, '0').slice(0, 40).replace(/[^0-9a-fA-F]/g, '1')}`;
}

interface ReceivedRequest {
  headers: Record<string, string>;
  body: string;
}

function startReceiver(
  handle: (received: ReceivedRequest, req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : (value ?? '')]),
        );
        handle({ headers, body: Buffer.concat(chunks).toString('utf8') }, req, res);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/webhook`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function guardedFetch(allowedUrl: string): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== allowedUrl) {
      throw new Error(`full-pipeline test guard: refusing a real request to unexpected URL ${String(url)}`);
    }
    return fetch(url, init);
  }) as typeof fetch;
}

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
  monitor = new MonitorService(db, 120);
});

afterAll(async () => {
  await db?.$disconnect();
});

describe('full pipeline: on-chain payment to a delivered, verifiable webhook', () => {
  it('carries a detected-then-paid invoice through real ledger posting and real webhook delivery', async () => {
    const merchantId = await createMerchant(db, { feeBps: 50 });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n, // 100 USDT
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const received: ReceivedRequest[] = [];
    const receiver = await startReceiver((req, _reqRaw, res) => {
      received.push(req);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });

    try {
      const secret = `whsec_${suffix()}`;
      await db.webhookEndpoint.create({
        data: {
          id: newId('webhookEndpoint'),
          merchantId,
          url: receiver.url,
          eventTypes: [],
          secretEncrypted: encryptSecret(secret, keyProvider),
          secretFingerprint: secret.slice(0, 8),
          enabled: true,
          maxAttempts: 3,
          timeoutMs: 5000,
        },
      });

      // --- Step 1: a real on-chain transfer arrives, detected by the monitor. ---
      const adapter = new FakeBlockchainAdapter(NETWORK);
      const txHash = freshHash('pipeline');
      const senderAddress = freshAddress();
      adapter.addBlock(
        makeTestBlock({
          number: 100n,
          hash: '0xpipelineblock100',
          parentHash: '0xpipelineblock99',
          transactions: [makeTestTransaction({ hash: txHash, blockNumber: 100n, blockHash: '0xpipelineblock100', fromAddress: senderAddress, toAddress: USDT_CONTRACT })],
        }),
      );
      adapter.setTransfers(txHash, [
        { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: senderAddress, toAddress: depositAddress.toLowerCase(), amount: 100_000_000n },
      ]);

      await monitor.processTransaction(adapter, NETWORK, txHash);
      await monitor.updateConfirmations(adapter, NETWORK); // 1 confirmation at the tip -> meets requiredConfirmations: 1

      const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(invoice.status).toBe('PAID');
      expect(decimalToUnits(invoice.receivedAmount)).toBe(100_000_000n);

      // --- Step 2: the ledger credit MonitorService posted is real and balanced. ---
      const ledgerTx = await db.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `credit:${NETWORK}:${txHash}:0` } });
      const entries = await db.ledgerEntry.findMany({ where: { ledgerTransactionId: ledgerTx.id } });
      const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + decimalToUnits(e.amount), 0n);
      const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + decimalToUnits(e.amount), 0n);
      expect(debits).toBe(credits);
      expect(debits).toBe(100_000_000n);

      // --- Step 3: the events MonitorService queued are actually delivered over real HTTP. ---
      const dispatcher = new WebhookDispatcher(db, {
        keyProvider,
        blockPrivateNetworks: false,
        fetchImpl: guardedFetch(receiver.url),
      });
      const summary = await dispatcher.runOnce();
      expect(summary.delivered).toBeGreaterThanOrEqual(3); // payment.detected, payment.confirming, payment.paid

      expect(received.length).toBeGreaterThanOrEqual(3);
      const eventTypes = received.map((r) => r.headers['x-webhook-event-type']).sort();
      expect(eventTypes).toEqual(['payment.confirming', 'payment.detected', 'payment.paid']);

      for (const req of received) {
        const verification = verifyWebhookSignature(secret, req.body, req.headers['x-signature']);
        expect(verification.valid).toBe(true);

        const payload = JSON.parse(req.body);
        expect(payload.data.invoice_id).toBe(invoiceId);
        expect(payload.data.order_id).toBe(invoice.orderId);
      }

      const detectedDelivery = await db.webhookDelivery.findFirstOrThrow({
        where: { webhookEvent: { idempotencyKey: `payment.detected:${invoiceId}` } },
      });
      const paidDelivery = await db.webhookDelivery.findFirstOrThrow({
        where: { webhookEvent: { idempotencyKey: `payment.paid:${invoiceId}` } },
      });
      expect(detectedDelivery.status).toBe('DELIVERED');
      expect(paidDelivery.status).toBe('DELIVERED');
    } finally {
      await receiver.close();
    }
  });
});
