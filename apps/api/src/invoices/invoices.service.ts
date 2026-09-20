import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  InvoiceStatus,
  Money,
  NotFoundError,
  ValidationError,
  assertNetworkMatchesLivemode,
  findAsset,
  findFiatCurrency,
  getNetworkConfig,
  isNetwork,
  isPriceable,
  newId,
} from '@gateway/shared';
import { type DatabaseClient, Prisma, runInTransaction, unitsToDecimal } from '@gateway/database';
import {
  TransitionActor,
  assertTransition,
  effectiveConfirmations,
  evaluateExpiry,
  isActorAllowed,
  webhookEventForStatus,
} from '@gateway/payments';
import type { ExchangeRateService } from '@gateway/exchange-rate';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { EXCHANGE_RATE_SERVICE } from '../common/exchange-rate.provider.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import type { MerchantContext } from '../auth/auth.types.js';
import type { CreateInvoiceDto } from './invoices.dto.js';
import {
  type InvoiceResponse,
  type InvoiceStatusResponse,
  type PublicInvoiceResponse,
  toInvoiceResponse,
  toInvoiceStatusResponse,
  toPublicInvoiceResponse,
} from './invoices.mapper.js';

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: { paymentAddress: true } }>;

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(EXCHANGE_RATE_SERVICE) private readonly rates: ExchangeRateService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createInvoice(merchant: MerchantContext, dto: CreateInvoiceDto): Promise<InvoiceResponse> {
    const networkKey = dto.network.toUpperCase();
    if (!isNetwork(networkKey)) {
      throw new AppError(ErrorCode.UNSUPPORTED_NETWORK, 400, `unsupported network: ${dto.network}`);
    }
    const networkConfig = getNetworkConfig(networkKey);
    assertNetworkMatchesLivemode(merchant.livemode, networkConfig);

    const currency = findFiatCurrency(dto.currency);
    if (!currency) {
      throw new ValidationError(`unsupported currency: ${dto.currency}`);
    }

    const assetSymbol = dto.asset.toUpperCase();
    const asset = findAsset(networkKey, assetSymbol);
    if (!asset) {
      throw new AppError(
        ErrorCode.UNSUPPORTED_ASSET,
        400,
        `asset ${assetSymbol} is not supported on ${networkConfig.displayName}`,
      );
    }

    if (!isPriceable(asset) && asset.symbol !== currency.code) {
      throw new AppError(
        ErrorCode.RATE_UNAVAILABLE,
        422,
        `${asset.symbol} has no price feed and cannot be priced in ${currency.code}`,
      );
    }

    let requestedMoney: Money;
    try {
      requestedMoney = Money.fromDecimal(dto.amount, currency.code, currency.decimals);
    } catch {
      throw new AppError(ErrorCode.INVALID_AMOUNT, 400, `invalid amount: ${dto.amount}`);
    }
    if (!requestedMoney.isPositive) {
      throw new AppError(ErrorCode.INVALID_AMOUNT, 400, 'amount must be greater than zero');
    }

    // Fail fast on a duplicate order_id before spending a scarce pool address
    // on a request that cannot succeed. The unique constraint on
    // (merchant_id, order_id) is still the actual guarantee for the case
    // where two requests for the same new order_id race each other; this is
    // purely to give the common (non-racing) case the right error instead of
    // ADDRESS_POOL_EXHAUSTED.
    const existingOrder = await this.db.invoice.findUnique({
      where: { merchantId_orderId: { merchantId: merchant.merchantId, orderId: dto.order_id } },
    });
    if (existingOrder) {
      throw new AppError(ErrorCode.DUPLICATE_ORDER_ID, 409, `an invoice already exists for order_id "${dto.order_id}"`);
    }

    const rate = await this.rates.getRate(asset.symbol, currency.code);
    const cryptoMoney = rate.convertQuoteToBase(requestedMoney, asset.decimals, 'ceil');

    const merchantRecord = await this.db.merchant.findUniqueOrThrow({ where: { id: merchant.merchantId } });

    const overrides = (merchantRecord.confirmationOverrides as Record<string, number>) ?? {};
    const requiredConfirmations = effectiveConfirmations(asset.requiredConfirmations, overrides[networkKey]);

    const expirySeconds = Math.min(merchantRecord.invoiceExpirySeconds, this.config.invoiceMaxExpirySeconds);
    const expiresAt = new Date(Date.now() + expirySeconds * 1000);

    const invoiceId = newId('invoice');

    try {
      // Concurrent invoice creations for the same merchant+network all read
      // the same address-pool predicate (`WHERE merchant_id = ... AND
      // network = ...`). `FOR UPDATE SKIP LOCKED` already stops two of them
      // from ever assigning the *same* row - that row lock, not Serializable,
      // is this transaction's actual correctness guarantee - but under
      // Serializable isolation Postgres's snapshot-conflict detector still
      // flags the overlapping reads and aborts a fraction of them anyway.
      // An advisory lock does not fix this: it only serialises *when* a
      // transaction proceeds past the lock wait, not the snapshot it already
      // took at its first statement, so a transaction that waited can still
      // be working from a snapshot older than what the lock holder just
      // committed - confirmed by load testing (ADR 0015), which still saw
      // `could not serialize access due to concurrent update` with an
      // advisory lock in place. Running this transaction at Read Committed
      // instead is correct specifically because the one thing that needs
      // protecting - never assigning the same address twice - is already a
      // real row lock, not a Serializable-only guarantee.
      const created = await runInTransaction(
        this.db,
        async (tx) => {
          // 1. Reserve a deposit address from the merchant's pool. FOR UPDATE
          //    SKIP LOCKED lets concurrent invoice creations each grab a
          //    different row instead of queueing behind one another.
          const candidates = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
            SELECT "id" FROM "payment_addresses"
            WHERE "merchant_id" = ${merchant.merchantId}
              AND "network" = ${networkKey}::"Network"
              AND "status" = 'AVAILABLE'
              AND ("asset_symbol" IS NULL OR "asset_symbol" = ${asset.symbol})
            ORDER BY "created_at" ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `);

          const addressRow = candidates[0];
          if (!addressRow) {
            throw new AppError(
              ErrorCode.ADDRESS_POOL_EXHAUSTED,
              422,
              `no available deposit address for ${asset.symbol} on ${networkConfig.displayName}. ` +
                'Register one with POST /v1/merchant/addresses.',
            );
          }

          // 2. Create the invoice (CREATED), then immediately move it to
          //    PENDING now that a destination exists - both transitions are
          //    validated against the state machine, not just asserted by fiat.
          assertTransition(InvoiceStatus.CREATED, InvoiceStatus.PENDING, TransitionActor.SYSTEM);

          await tx.invoice.create({
            data: {
              id: invoiceId,
              merchantId: merchant.merchantId,
              orderId: dto.order_id,
              externalReference: dto.external_reference ?? null,
              description: dto.description ?? null,
              requestedCurrency: currency.code,
              requestedDecimals: currency.decimals,
              requestedAmount: unitsToDecimal(requestedMoney.units),
              paymentAsset: asset.symbol,
              paymentDecimals: asset.decimals,
              network: networkKey,
              tokenContract: asset.contractAddress,
              cryptoAmount: unitsToDecimal(cryptoMoney.units),
              exchangeRate: unitsToDecimal(rate.numerator),
              exchangeRateProvider: rate.provider,
              exchangeRateAt: rate.observedAt,
              underpaymentPolicy: merchantRecord.underpaymentPolicy,
              overpaymentPolicy: merchantRecord.overpaymentPolicy,
              underpaymentToleranceBps: merchantRecord.underpaymentToleranceBps,
              overpaymentToleranceBps: merchantRecord.overpaymentToleranceBps,
              requiredConfirmations,
              status: InvoiceStatus.PENDING,
              callbackUrl: dto.callback_url ?? null,
              redirectUrl: dto.redirect_url ?? null,
              metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
              expiresAt,
            },
          });

          await tx.paymentAddress.update({
            where: { id: addressRow.id },
            data: { status: 'ASSIGNED', invoiceId, assignedAt: new Date() },
          });

          await tx.paymentEvent.createMany({
            data: [
              {
                id: newId('paymentEvent'),
                invoiceId,
                type: 'invoice.created',
                fromStatus: null,
                toStatus: InvoiceStatus.CREATED,
                sequence: 1,
                actor: 'system',
              },
              {
                id: newId('paymentEvent'),
                invoiceId,
                type: 'payment.created',
                fromStatus: InvoiceStatus.CREATED,
                toStatus: InvoiceStatus.PENDING,
                sequence: 2,
                actor: 'system',
                payload: { address: addressRow.id },
              },
            ],
          });

          const eventType = webhookEventForStatus(InvoiceStatus.PENDING);
          if (eventType) {
            await tx.webhookEvent.create({
              data: {
                id: newId('webhookEvent'),
                merchantId: merchant.merchantId,
                invoiceId,
                type: eventType,
                idempotencyKey: `${eventType}:${invoiceId}`,
                payload: {
                  event: eventType,
                  data: {
                    invoice_id: invoiceId,
                    order_id: dto.order_id,
                    amount: cryptoMoney.toDecimalString(),
                    asset: asset.symbol,
                    network: networkKey,
                  },
                } as Prisma.InputJsonValue,
              },
            });
          }

          return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { paymentAddress: true } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );

      return toInvoiceResponse(created, {
        paymentAddress: created.paymentAddress?.address ?? null,
        transactionHash: null,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(
          ErrorCode.DUPLICATE_ORDER_ID,
          409,
          `an invoice already exists for order_id "${dto.order_id}"`,
        );
      }
      throw error;
    }
  }

  async getInvoice(merchant: MerchantContext, id: string): Promise<InvoiceResponse> {
    const invoice = await this.loadAndMaybeExpire(merchant.merchantId, id);
    const transactionHash = await this.latestCreditingTxHash(id);
    return toInvoiceResponse(invoice, { paymentAddress: invoice.paymentAddress?.address ?? null, transactionHash });
  }

  /**
   * The hosted payment page's only data source (Phase 7) - unauthenticated,
   * scoped by nothing but the invoice `id` itself. Looked up in two steps
   * because `loadAndMaybeExpire` needs a `merchantId` up front (it's shared
   * with the merchant-authenticated read path, which already has one from
   * `ApiKeyGuard`); here there is no guard to supply it; we discover it from
   * the invoice itself before running the same lazy-expiry check every other
   * read path uses.
   */
  async getPublicInvoice(id: string): Promise<PublicInvoiceResponse> {
    const found = await this.db.invoice.findUnique({ where: { id }, select: { merchantId: true } });
    if (!found) throw new NotFoundError('invoice', id);

    const invoice = await this.loadAndMaybeExpire(found.merchantId, id);
    const transactionHash = await this.latestCreditingTxHash(id);
    const merchant = await this.db.merchant.findUniqueOrThrow({
      where: { id: found.merchantId },
      select: { name: true },
    });

    return toPublicInvoiceResponse(invoice, {
      paymentAddress: invoice.paymentAddress?.address ?? null,
      transactionHash,
      merchantName: merchant.name,
    });
  }

  async getInvoiceStatus(merchant: MerchantContext, id: string): Promise<InvoiceStatusResponse> {
    const invoice = await this.loadAndMaybeExpire(merchant.merchantId, id);
    const transactionHash = await this.latestCreditingTxHash(id);
    return toInvoiceStatusResponse(invoice, { transactionHash });
  }

  async cancelInvoice(merchant: MerchantContext, id: string): Promise<InvoiceResponse> {
    const invoice = await this.loadAndMaybeExpire(merchant.merchantId, id);

    // assertTransition is the single source of truth for "can this be
    // cancelled right now" - it throws a 409 with the reason if not.
    assertTransition(invoice.status, InvoiceStatus.CANCELLED, TransitionActor.MERCHANT);

    const updated = await runInTransaction(this.db, async (tx) => {
      await tx.invoice.update({
        where: { id },
        data: { status: InvoiceStatus.CANCELLED, cancelledAt: new Date(), version: { increment: 1 } },
      });

      if (invoice.paymentAddress) {
        // Retired, never returned to the pool (SPEC section 8: never reuse).
        await tx.paymentAddress.update({
          where: { id: invoice.paymentAddress.id },
          data: { status: 'RETIRED', retiredAt: new Date() },
        });
      }

      const nextSequence = (await tx.paymentEvent.count({ where: { invoiceId: id } })) + 1;
      await tx.paymentEvent.create({
        data: {
          id: newId('paymentEvent'),
          invoiceId: id,
          type: 'payment.cancelled',
          fromStatus: invoice.status,
          toStatus: InvoiceStatus.CANCELLED,
          sequence: nextSequence,
          actor: `merchant:${merchant.merchantId}`,
        },
      });

      const eventType = webhookEventForStatus(InvoiceStatus.CANCELLED);
      if (eventType) {
        await tx.webhookEvent.create({
          data: {
            id: newId('webhookEvent'),
            merchantId: merchant.merchantId,
            invoiceId: id,
            type: eventType,
            idempotencyKey: `${eventType}:${id}`,
            payload: { event: eventType, data: { invoice_id: id, order_id: invoice.orderId } } as Prisma.InputJsonValue,
          },
        });
      }

      return tx.invoice.findUniqueOrThrow({ where: { id }, include: { paymentAddress: true } });
    });

    return toInvoiceResponse(updated, { paymentAddress: null, transactionHash: null });
  }

  /**
   * Read-time lazy expiry: PENDING/UNDERPAID invoices past `expiresAt` flip to
   * EXPIRED on the next read. This is a stopgap for the proactive sweep worker
   * (SPEC Phase 2/10) which is not yet implemented - see README roadmap.
   * DETECTED/CONFIRMING never expire here: once a real transaction exists,
   * only the confirmation engine may resolve the invoice.
   */
  private async loadAndMaybeExpire(merchantId: string, id: string): Promise<InvoiceRow> {
    const invoice = await this.db.invoice.findFirst({
      where: { id, merchantId },
      include: { paymentAddress: true },
    });
    if (!invoice) throw new NotFoundError('invoice', id);

    // isActorAllowed, not the actor-blind canTransition: RECONCILIATION_REQUIRED
    // has an EXPIRED edge too, but it is ADMIN-only (an operator resolving a
    // discrepancy), and assertTransition below would throw if this path ever
    // reached it as TransitionActor.SYSTEM.
    if (isActorAllowed(invoice.status, InvoiceStatus.EXPIRED, TransitionActor.SYSTEM) && evaluateExpiry(invoice.expiresAt).expired) {
      return runInTransaction(this.db, async (tx) => {
        const fresh = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { paymentAddress: true } });
        if (!isActorAllowed(fresh.status, InvoiceStatus.EXPIRED, TransitionActor.SYSTEM) || !evaluateExpiry(fresh.expiresAt).expired) {
          return fresh; // lost the race to another reader; already handled
        }

        assertTransition(fresh.status, InvoiceStatus.EXPIRED, TransitionActor.SYSTEM);
        await tx.invoice.update({
          where: { id },
          data: { status: InvoiceStatus.EXPIRED, expiredAt: new Date(), version: { increment: 1 } },
        });

        const nextSequence = (await tx.paymentEvent.count({ where: { invoiceId: id } })) + 1;
        await tx.paymentEvent.create({
          data: {
            id: newId('paymentEvent'),
            invoiceId: id,
            type: 'payment.expired',
            fromStatus: fresh.status,
            toStatus: InvoiceStatus.EXPIRED,
            sequence: nextSequence,
            actor: 'system',
          },
        });

        const eventType = webhookEventForStatus(InvoiceStatus.EXPIRED);
        if (eventType) {
          await tx.webhookEvent.create({
            data: {
              id: newId('webhookEvent'),
              merchantId,
              invoiceId: id,
              type: eventType,
              idempotencyKey: `${eventType}:${id}`,
              payload: { event: eventType, data: { invoice_id: id, order_id: fresh.orderId } } as Prisma.InputJsonValue,
            },
          });
        }

        return tx.invoice.findUniqueOrThrow({ where: { id }, include: { paymentAddress: true } });
      });
    }

    return invoice;
  }

  private async latestCreditingTxHash(invoiceId: string): Promise<string | null> {
    const transfer = await this.db.tokenTransfer.findFirst({
      where: { invoiceId, matchStatus: 'CREDITED' },
      orderBy: { detectedAt: 'desc' },
    });
    return transfer?.txHash ?? null;
  }
}
