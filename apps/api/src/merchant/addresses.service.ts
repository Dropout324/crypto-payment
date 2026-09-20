import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  assertNetworkMatchesLivemode,
  findAsset,
  findNativeAsset,
  getNetworkConfig,
  isNetwork,
  newId,
} from '@gateway/shared';
import { isStructurallyValidEvmAddress, isValidBitcoinAddress, isValidEvmAddress, normalizeEvmAddress } from '@gateway/blockchain';
import { type DatabaseClient, Prisma } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import type { MerchantContext } from '../auth/auth.types.js';
import type { RegisterAddressDto } from './addresses.dto.js';

export interface AddressResponse {
  id: string;
  network: string;
  asset: string;
  address: string;
  status: string;
  created_at: string;
}

@Injectable()
export class AddressesService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async register(merchant: MerchantContext, dto: RegisterAddressDto): Promise<AddressResponse> {
    const networkKey = dto.network.toUpperCase();
    if (!isNetwork(networkKey)) {
      throw new AppError(ErrorCode.UNSUPPORTED_NETWORK, 400, `unsupported network: ${dto.network}`);
    }
    const networkConfig = getNetworkConfig(networkKey);
    assertNetworkMatchesLivemode(merchant.livemode, networkConfig);

    const assetSymbol = dto.asset.toUpperCase();
    const asset = findAsset(networkKey, assetSymbol) ?? findNativeAsset(networkKey);
    if (!asset || asset.symbol !== assetSymbol) {
      throw new AppError(ErrorCode.UNSUPPORTED_ASSET, 400, `asset ${assetSymbol} is not supported on ${networkConfig.displayName}`);
    }

    const normalized = this.validateAndNormalize(networkConfig.family, dto.address, networkKey);

    const id = newId('paymentAddress');
    try {
      const created = await this.db.paymentAddress.create({
        data: {
          id,
          merchantId: merchant.merchantId,
          network: networkKey,
          address: dto.address,
          addressNormalized: normalized,
          assetSymbol: asset.symbol,
          status: 'AVAILABLE',
        },
      });
      return this.toResponse(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(
          ErrorCode.CONFLICT,
          409,
          `address ${dto.address} is already registered on ${networkConfig.displayName}`,
        );
      }
      throw error;
    }
  }

  async list(merchant: MerchantContext, network?: string): Promise<AddressResponse[]> {
    const where: Prisma.PaymentAddressWhereInput = { merchantId: merchant.merchantId };
    if (network) {
      const networkKey = network.toUpperCase();
      if (!isNetwork(networkKey)) throw new AppError(ErrorCode.UNSUPPORTED_NETWORK, 400, `unsupported network: ${network}`);
      where.network = networkKey;
    }

    const rows = await this.db.paymentAddress.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((row) => this.toResponse(row));
  }

  private validateAndNormalize(family: 'evm' | 'bitcoin', address: string, network: string): string {
    if (family === 'evm') {
      if (!isStructurallyValidEvmAddress(address)) {
        throw new AppError(ErrorCode.INVALID_ADDRESS, 400, `"${address}" is not a well-formed address for this network`);
      }
      if (!isValidEvmAddress(address)) {
        throw new AppError(
          ErrorCode.INVALID_ADDRESS,
          400,
          `"${address}" has an invalid EIP-55 checksum - check for a typo`,
        );
      }
      return normalizeEvmAddress(address);
    }

    const bitcoinNetwork = network.includes('TESTNET') ? 'testnet' : 'mainnet';
    if (!isValidBitcoinAddress(address, bitcoinNetwork)) {
      throw new AppError(ErrorCode.INVALID_ADDRESS, 400, `"${address}" is not a valid Bitcoin ${bitcoinNetwork} address`);
    }
    return address;
  }

  private toResponse(row: { id: string; network: string; assetSymbol: string | null; address: string; status: string; createdAt: Date }): AddressResponse {
    return {
      id: row.id,
      network: row.network,
      asset: row.assetSymbol ?? 'ANY',
      address: row.address,
      status: row.status,
      created_at: row.createdAt.toISOString(),
    };
  }
}
