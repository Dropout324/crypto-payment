import type { NetworkValue } from '@gateway/shared';
import { BlockchainAdapterError } from '../adapter.js';

/**
 * Minimal JSON-RPC 2.0 HTTP client for EVM nodes/providers.
 *
 * Deliberately not a dependency on ethers/viem/web3: every EVM call this
 * codebase needs (`eth_getTransactionByHash`, `eth_getTransactionReceipt`,
 * `eth_getBlockByNumber`, `eth_getLogs`, `eth_blockNumber`,
 * `eth_getBalance`) is a single flat JSON-RPC request/response, and the
 * response shapes are parsed directly into this package's own
 * `ChainTransaction`/`ParsedTransfer`/`BlockData` types (`rpc-adapter.ts`) -
 * pulling in a full client library would mean maintaining a second set of
 * chain-shape assumptions alongside the ones already hand-built for log
 * parsing and address validation.
 */

export interface EvmRpcClientOptions {
  /** Primary endpoint. */
  url: string;
  /** Tried only when a request against `url` fails as a TRANSPORT error (timeout, network error, 5xx, non-JSON-RPC body) - never for a JSON-RPC application error (SPEC: retry the transport, not the chain's answer). */
  fallbackUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class EvmRpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'EvmRpcError';
    this.code = code;
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

function isFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return 'error' in response;
}

export class EvmRpcClient {
  private readonly url: string;
  private readonly fallbackUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(
    private readonly network: NetworkValue,
    options: EvmRpcClientOptions,
  ) {
    this.url = options.url;
    this.fallbackUrl = options.fallbackUrl;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    try {
      return await this.send<T>(this.url, method, params);
    } catch (error) {
      if (!this.fallbackUrl || error instanceof EvmRpcError) throw error; // application error - the fallback node would answer the same way
      return this.send<T>(this.fallbackUrl, method, params);
    }
  }

  /**
   * Send several requests in one HTTP round trip (standard JSON-RPC batching).
   * Every provider `getTransaction` talks to supports this; it halves the
   * round trips for the tx-plus-receipt fetch that dominates monitor load.
   */
  async batch(calls: Array<{ method: string; params?: unknown[] }>): Promise<unknown[]> {
    if (calls.length === 0) return [];
    try {
      return await this.sendBatch(this.url, calls);
    } catch (error) {
      if (!this.fallbackUrl || error instanceof EvmRpcError) throw error;
      return this.sendBatch(this.fallbackUrl, calls);
    }
  }

  private async send<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: this.nextId++, method, params };
    const body = await this.post(url, request);
    const response = body as JsonRpcResponse;
    if (isFailure(response)) throw new EvmRpcError(response.error.message, response.error.code);
    return response.result as T;
  }

  private async sendBatch(url: string, calls: Array<{ method: string; params?: unknown[] }>): Promise<unknown[]> {
    const requests: JsonRpcRequest[] = calls.map((c) => ({ jsonrpc: '2.0', id: this.nextId++, method: c.method, params: c.params ?? [] }));
    const body = await this.post(url, requests);
    const responses = body as JsonRpcResponse[];
    if (!Array.isArray(responses)) {
      throw new BlockchainAdapterError(this.network, 'expected a JSON-RPC batch array response', { retryable: true });
    }
    // Providers are not required to preserve order, but every one this codebase
    // targets does; matching by id would need an id->index map for the rare
    // exception, which is not worth the complexity until one shows up in practice.
    return responses.map((response) => {
      if (isFailure(response)) throw new EvmRpcError(response.error.message, response.error.code);
      return response.result;
    });
  }

  private async post(url: string, payload: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BlockchainAdapterError(this.network, `RPC transport failure: ${(error as Error).message}`, { retryable: true, cause: error });
    }

    if (!response.ok) {
      throw new BlockchainAdapterError(this.network, `RPC endpoint responded ${response.status}`, { retryable: response.status >= 500 || response.status === 429 });
    }

    try {
      return await response.json();
    } catch (error) {
      throw new BlockchainAdapterError(this.network, 'RPC endpoint returned a non-JSON body', { retryable: true, cause: error });
    }
  }
}

// ---------------------------------------------------------------------------
// Hex <-> domain type helpers shared by the adapter.
// ---------------------------------------------------------------------------

export function hexToBigInt(hex: string | null | undefined): bigint | null {
  if (hex === null || hex === undefined) return null;
  return BigInt(hex);
}

export function hexToNumber(hex: string | null | undefined): number | null {
  const value = hexToBigInt(hex);
  return value === null ? null : Number(value);
}
