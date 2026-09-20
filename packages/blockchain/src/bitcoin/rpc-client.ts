import type { NetworkValue } from '@gateway/shared';
import { BlockchainAdapterError } from '../adapter.js';

/**
 * Minimal JSON-RPC client for Bitcoin Core (`bitcoind`) or a compatible node.
 *
 * Deliberately not a dependency on bitcoinjs-lib or any other chain SDK, for
 * the same reason `EvmRpcClient` avoids ethers/viem (see its file comment):
 * every call this codebase needs (`getblockcount`, `getblockhash`,
 * `getblock`, `getblockheader`, `getrawtransaction`, `scantxoutset`) is a
 * single flat JSON-RPC request, and Bitcoin Core already returns transaction
 * outputs pre-decoded with a resolved `address` field - there is no
 * script-parsing this package needs to own.
 */

export interface BitcoinRpcClientOptions {
  /** e.g. "http://127.0.0.1:18443" for a local regtest node. */
  url: string;
  rpcUser?: string;
  rpcPassword?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A well-formed JSON-RPC error response from the node - "not found" (-5) is handled by callers, everything else is a real failure. */
export class BitcoinRpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'BitcoinRpcError';
    this.code = code;
  }
}

/** Bitcoin Core's own error code for "no such mempool or blockchain transaction" / unknown block hash. */
export const RPC_INVALID_ADDRESS_OR_KEY = -5;

interface JsonRpcRequest {
  jsonrpc: '1.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  result: unknown;
  error: { code: number; message: string } | null;
  id: number;
}

export class BitcoinRpcClient {
  private readonly url: string;
  private readonly authHeader: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(
    private readonly network: NetworkValue,
    options: BitcoinRpcClientOptions,
  ) {
    this.url = options.url;
    this.authHeader =
      options.rpcUser !== undefined
        ? `Basic ${Buffer.from(`${options.rpcUser}:${options.rpcPassword ?? ''}`).toString('base64')}`
        : undefined;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const request: JsonRpcRequest = { jsonrpc: '1.0', id: this.nextId++, method, params };

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authHeader ? { authorization: this.authHeader } : {}),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BlockchainAdapterError(this.network, `RPC transport failure: ${(error as Error).message}`, { retryable: true, cause: error });
    }

    // Bitcoin Core answers a JSON-RPC application error with HTTP 500, unlike
    // EVM providers, which return 200 with an `error` field - the body still
    // carries a well-formed {result, error, id} in both cases, so read it
    // before deciding whether this is a transport failure.
    let body: JsonRpcResponse;
    try {
      body = (await response.json()) as JsonRpcResponse;
    } catch (error) {
      throw new BlockchainAdapterError(this.network, 'RPC endpoint returned a non-JSON body', { retryable: true, cause: error });
    }

    if (body.error) throw new BitcoinRpcError(body.error.message, body.error.code);
    if (!response.ok) {
      throw new BlockchainAdapterError(this.network, `RPC endpoint responded ${response.status}`, { retryable: response.status >= 500 || response.status === 429 });
    }
    return body.result as T;
  }
}

/**
 * Bitcoin Core reports amounts as a JSON number of whole BTC with up to 8
 * decimal places. Converting via floating-point multiplication is safe here
 * specifically because the value space is bounded (21M BTC ceiling, far under
 * `Number.MAX_SAFE_INTEGER` once scaled by 1e8) and the input already carries
 * no more than 8 decimal digits - `Math.round` cancels the sub-satoshi
 * floating-point noise that multiplication can introduce.
 */
export function btcToSatoshis(amount: number): bigint {
  return BigInt(Math.round(amount * 1e8));
}
