import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError, isNetwork } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { toTransactionResponse, type TransactionResponse } from './transactions.mapper.js';

@Injectable()
export class TransactionsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async getByHash(merchantId: string, network: string, txHash: string): Promise<TransactionResponse> {
    const networkKey = network.toUpperCase();
    if (!isNetwork(networkKey)) {
      throw new ValidationError(`unsupported network: ${network}`);
    }

    const tx = await this.db.blockchainTransaction.findUnique({
      where: { network_txHash: { network: networkKey, txHash } },
    });
    if (!tx) throw new NotFoundError('transaction', txHash);

    const transfers = await this.db.tokenTransfer.findMany({
      where: { transactionId: tx.id },
      orderBy: { transferIndex: 'asc' },
    });

    // A hash is unique per network, not globally, and the transaction row
    // itself carries no merchant - ownership is proven only if at least one
    // of its transfers reaches this merchant's invoice or deposit address.
    // A 404 either way: never reveal that a hash belongs to someone else.
    if (!(await this.belongsToMerchant(transfers, merchantId))) {
      throw new NotFoundError('transaction', txHash);
    }

    return toTransactionResponse(tx, transfers);
  }

  private async belongsToMerchant(
    transfers: Array<{ invoiceId: string | null; paymentAddressId: string | null }>,
    merchantId: string,
  ): Promise<boolean> {
    const invoiceIds = [...new Set(transfers.map((t) => t.invoiceId).filter((id): id is string => id !== null))];
    const addressIds = [...new Set(transfers.map((t) => t.paymentAddressId).filter((id): id is string => id !== null))];

    if (invoiceIds.length > 0) {
      const count = await this.db.invoice.count({ where: { id: { in: invoiceIds }, merchantId } });
      if (count > 0) return true;
    }
    if (addressIds.length > 0) {
      const count = await this.db.paymentAddress.count({ where: { id: { in: addressIds }, merchantId } });
      if (count > 0) return true;
    }
    return false;
  }
}
