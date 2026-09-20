export interface BalanceEntry {
  network: string;
  asset: string;
  available: string;
}

export interface BalanceResponse {
  balances: BalanceEntry[];
}
